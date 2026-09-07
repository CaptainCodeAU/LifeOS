/**
 * Requirements 5 and 2 (free local engine as default; prepend silence for
 * device warm-up): LifeOS 7.x ships with no local TTS engine at all —
 * `generateSpeech` in voice.ts only ever calls ElevenLabs, and the whole
 * voice path is gated on `elevenlabs_api_key` being set. This is the local
 * fallback: macOS's built-in `say`, used whenever the paid path is off, so
 * voice notifications work with zero configuration.
 *
 * New file at a path upstream never ships — never touched by an update,
 * never conflicts on merge (see Tools/InstallEngine.ts's "same relative
 * path" overlay contract). The one hook into upstream code is the branch
 * in sendNotification() that calls this when there's no API key.
 *
 * Renders to a file first, same as playAudio() does for the ElevenLabs
 * path (requirement 1) — `say -o` writes AIFF, never streamed to a player.
 *
 * Voice/rate/warm-up-silence are read from settings.json's `voice.localEngine`
 * block, not hardcoded — a fixed default sounded wrong for this machine on
 * first real use (2026-09-08: reported as "slow" — the 450ms silence prefix
 * dominates a short notification's total length; "wrong speaker" is a taste
 * call only the operator can make, not something to guess a fix for).
 */

import { spawn } from "child_process"
import { rmSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "node:os"

// Gavin's actual prior voice (found in the archived PAI VoiceServer,
// server.ts:420-427: `say -v Victoria -r 450`). Set as the intended default —
// but Victoria is a downloadable "Enhanced" voice, not installed on this Mac
// by default (confirmed via `say -v '?'`), so isVoiceInstalled() below guards
// it: falls back to a voice that's always present rather than erroring the
// whole notification if it hasn't been downloaded yet (System Settings →
// Accessibility → Spoken Content → System Voice → Manage Voices).
const PREFERRED_VOICE = "Victoria"
const SAFE_FALLBACK_VOICE = "Samantha"
// Matches the historical rate (server.ts:423-424) — the previous 450ms-with-
// no-rate-override default played at under half this speed, which is almost
// certainly the "talking slowly" complaint.
const FALLBACK_RATE_WPM = 450
// Requirement 2's own stated need is "~200-400ms" — 450 overshot it and, for a
// short notification, that half-second of dead air is a large fraction of the
// whole message. 150ms default; override via settings.json if a real device
// still clips, or set to 0 to disable.
const FALLBACK_WARMUP_SILENCE_MS = 150

let installedVoicesCache: Set<string> | undefined = undefined

function isVoiceInstalled(name: string): boolean {
  if (installedVoicesCache === undefined) {
    installedVoicesCache = new Set()
    try {
      const result = Bun.spawnSync(["say", "-v", "?"])
      const text = new TextDecoder().decode(result.stdout)
      for (const line of text.split("\n")) {
        const match = line.match(/^(\S+(?: \([^)]+\))?)\s+\S+\s+#/)
        if (match) installedVoicesCache.add(match[1])
      }
    } catch {
      // leave the cache empty — resolveVoice() falls through to the safe default
    }
  }
  return installedVoicesCache.has(name)
}

interface LocalEngineConfig {
  voiceName: string
  rateWpm?: number
  warmupSilenceMs: number
}

let cachedConfig: LocalEngineConfig | undefined = undefined

function loadLocalEngineConfig(): LocalEngineConfig {
  if (cachedConfig !== undefined) return cachedConfig

  const fallback: LocalEngineConfig = {
    voiceName: PREFERRED_VOICE,
    rateWpm: FALLBACK_RATE_WPM,
    warmupSilenceMs: FALLBACK_WARMUP_SILENCE_MS,
  }

  try {
    const settingsPath = join(homedir(), ".claude", "settings.json")
    if (!existsSync(settingsPath)) {
      cachedConfig = fallback
      return cachedConfig
    }
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
    const cfg = settings.voice?.localEngine ?? {}
    cachedConfig = {
      voiceName: typeof cfg.voiceName === "string" && cfg.voiceName ? cfg.voiceName : fallback.voiceName,
      rateWpm: typeof cfg.rateWpm === "number" ? cfg.rateWpm : fallback.rateWpm,
      warmupSilenceMs: typeof cfg.warmupSilenceMs === "number" ? cfg.warmupSilenceMs : fallback.warmupSilenceMs,
    }
  } catch {
    cachedConfig = fallback
  }
  return cachedConfig
}

let sayAvailable: boolean | undefined = undefined

export function localSayAvailable(): boolean {
  if (sayAvailable !== undefined) return sayAvailable
  sayAvailable = process.platform === "darwin" && !!Bun.which("say")
  return sayAvailable
}

/**
 * Synthesize speech with macOS `say`, returning the rendered audio as a
 * buffer — same shape as voice.ts's generateSpeech(), so callers (playAudio,
 * enqueuePlayback) don't need to know which engine produced it.
 */
export async function generateLocalSpeech(text: string, voiceName?: string): Promise<ArrayBuffer> {
  if (!localSayAvailable()) {
    throw new Error("Local speech engine (say) is not available on this platform")
  }

  const config = loadLocalEngineConfig()
  let voice = voiceName || config.voiceName
  if (!isVoiceInstalled(voice)) {
    console.error(`[Voice] "${voice}" is not installed (System Settings → Accessibility → ` +
      `Spoken Content → System Voice → Manage Voices to download it) — using "${SAFE_FALLBACK_VOICE}" instead`)
    voice = SAFE_FALLBACK_VOICE
  }
  const tempFile = `/tmp/voice-local-${Date.now()}-${Math.random().toString(36).slice(2)}.aiff`
  const embeddedText = config.warmupSilenceMs > 0 ? `[[slnc ${config.warmupSilenceMs}]]${text}` : text

  const args = ["-v", voice]
  if (config.rateWpm) args.push("-r", String(config.rateWpm))
  args.push("-o", tempFile, embeddedText)

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("say", args)

    proc.on("error", (error) => reject(error))
    proc.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`say exited with code ${code}`))
    })
  })

  try {
    return await Bun.file(tempFile).arrayBuffer()
  } finally {
    try { rmSync(tempFile, { force: true }) } catch {}
  }
}
