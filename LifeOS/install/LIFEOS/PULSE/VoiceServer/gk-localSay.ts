/**
 * Local TTS engine for LifeOS voice notifications.
 *
 * LifeOS 7.x ships with no local TTS at all — `generateSpeech` in voice.ts only
 * ever calls ElevenLabs, and the whole voice path is gated on
 * `elevenlabs_api_key` being set. This is the local path, used whenever the paid
 * path is off, so voice notifications work with zero configuration.
 *
 * New file at a path upstream never ships — never touched by an update, never
 * conflicts on merge (see Tools/InstallEngine.ts's "same relative path" overlay
 * contract). The one hook into upstream code is the branch in sendNotification()
 * that calls this when there's no API key.
 *
 * TWO ENGINES, IN ORDER (2026-09-08):
 *
 *   1. `say2` — neural Siri voices via a private Apple framework.
 *      https://github.com/CaptainCodeAU/say2
 *   2. `say`  — macOS built-in. Always present. The safety net.
 *
 * Why say2 is preferred, measured on this Mac rather than assumed:
 *   - `say` is hard-capped at 22050 Hz mono. Energy above 11 kHz measured at
 *     -82.5 dB, i.e. nothing. That band-limiting IS the "muffled" complaint.
 *   - say2 renders the same voice at 48000 Hz: -40.4 dB above 11 kHz. A 42 dB
 *     recovery of the detail that makes consonants legible.
 *   - say2 is also ~5.6x FASTER (0.118s vs 0.66s to render the same sentence),
 *     so there is no tradeoff to weigh.
 *   - Apple does not expose the Siri "natural" voices to `say` or to public
 *     AVSpeechSynthesizer at all, so no `say` configuration can close this gap.
 *
 * Why the `say` fallback is not optional: say2 reaches a PRIVATE Apple
 * framework. A macOS update can remove or rename it with no warning. say2 exits
 * 69 for exactly that case ("permanent, not a hiccup" — `say2 --explain 69`).
 * When say2 fails for any reason we fall through to `say` rather than going
 * silent. A degraded notification beats a missed one.
 *
 * NO WARM-UP SILENCE for say2: it already emits ~320 ms of leading silence with
 * no prompting (measured: first sound at 0.319979 s). The `[[slnc]]` prefix this
 * file used to add is retained for the `say` fallback only, where it is still
 * needed. Note that `say` swallows any `[[slnc]]` below ~265 ms entirely, so the
 * old 150 ms default was silently producing ZERO padding — hence the higher
 * default below.
 *
 * Config lives in settings.json under `voice.localEngine`; nothing here is
 * hardcoded beyond the defaults, which are the values chosen by ear on this
 * machine on 2026-09-08.
 */

import { spawn } from "child_process"
import { rmSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "node:os"

// ── say2 (preferred) ──

// The asset behind this Mac's "Siri (Voice 1)" system voice
// (com.apple.siri.natural.Aaron). Chosen by ear over the neuralAX variant: both
// carry identical frequency content, but `natural` places pauses and stress
// differently and takes 31% longer to say the same sentence. That prosody is
// the whole reason to prefer it.
const DEFAULT_SAY2_VOICE = "en-US:natural:male:Aaron:premium:5030"
// Chosen against a dense technical sentence (timestamp, commit hash, ratio,
// product name). Above ~500 the gains flatten: each further 50 wpm buys about
// two tenths of a second while compressing the pacing this voice was picked for.
const DEFAULT_SAY2_RATE_WPM = 500
// say2 exits 69 when the private Siri framework is gone — permanent, not
// transient. We fall back on ANY say2 failure, but this code is logged
// distinctly because it means "stop expecting say2 to work until it's updated".
const SAY2_EXIT_FRAMEWORK_UNAVAILABLE = 69

// ── say (fallback) ──

const DEFAULT_SAY_VOICE = "Samantha"
const DEFAULT_SAY_RATE_WPM = 450
// `say` discards any [[slnc]] below ~265 ms outright (measured: 100/150/250 ms
// all produce 0 ms of actual silence; 500 ms produces ~235 ms). 400 ms is the
// smallest value that reliably yields a real pad. Set to 0 to disable.
const DEFAULT_SAY_WARMUP_SILENCE_MS = 400

export type LocalAudioFormat = "wav" | "aiff"

export interface LocalSpeechResult {
  audio: ArrayBuffer
  /** Which container the buffer is in. playAudio() needs this for its temp-file
   *  extension — afplay parses by extension, and a wrong one fails outright. */
  format: LocalAudioFormat
  /** Which engine actually produced this. Logged by the caller. */
  engine: "say2" | "say"
}

interface LocalEngineConfig {
  say2Voice: string
  say2RateWpm: number
  sayVoice: string
  sayRateWpm: number
  sayWarmupSilenceMs: number
  /** Set false to skip say2 entirely and use `say`. Escape hatch. */
  preferSay2: boolean
}

let cachedConfig: LocalEngineConfig | undefined = undefined

function loadLocalEngineConfig(): LocalEngineConfig {
  if (cachedConfig !== undefined) return cachedConfig

  const fallback: LocalEngineConfig = {
    say2Voice: DEFAULT_SAY2_VOICE,
    say2RateWpm: DEFAULT_SAY2_RATE_WPM,
    sayVoice: DEFAULT_SAY_VOICE,
    sayRateWpm: DEFAULT_SAY_RATE_WPM,
    sayWarmupSilenceMs: DEFAULT_SAY_WARMUP_SILENCE_MS,
    preferSay2: true,
  }

  try {
    const settingsPath = join(homedir(), ".claude", "settings.json")
    if (!existsSync(settingsPath)) {
      cachedConfig = fallback
      return cachedConfig
    }
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
    const cfg = settings.voice?.localEngine ?? {}
    const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d)
    const num = (v: unknown, d: number) => (typeof v === "number" ? v : d)
    cachedConfig = {
      say2Voice: str(cfg.say2Voice, fallback.say2Voice),
      say2RateWpm: num(cfg.say2RateWpm, fallback.say2RateWpm),
      // `voiceName`/`rateWpm`/`warmupSilenceMs` are the pre-say2 key names.
      // Still honoured so an existing settings.json keeps working.
      sayVoice: str(cfg.sayVoice ?? cfg.voiceName, fallback.sayVoice),
      sayRateWpm: num(cfg.sayRateWpm ?? cfg.rateWpm, fallback.sayRateWpm),
      sayWarmupSilenceMs: num(cfg.sayWarmupSilenceMs ?? cfg.warmupSilenceMs, fallback.sayWarmupSilenceMs),
      preferSay2: cfg.preferSay2 !== false,
    }
  } catch {
    cachedConfig = fallback
  }
  return cachedConfig
}

// ── availability ──

let say2Available: boolean | undefined = undefined
let sayAvailable: boolean | undefined = undefined

function hasSay2(): boolean {
  if (say2Available === undefined) say2Available = process.platform === "darwin" && !!Bun.which("say2")
  return say2Available
}

function hasSay(): boolean {
  if (sayAvailable === undefined) sayAvailable = process.platform === "darwin" && !!Bun.which("say")
  return sayAvailable
}

/** True when ANY local engine can speak. voice.ts gates the local branch on this. */
export function localSayAvailable(): boolean {
  return hasSay2() || hasSay()
}

let installedVoicesCache: Set<string> | undefined = undefined

function isSayVoiceInstalled(name: string): boolean {
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
      // leave the cache empty — caller falls through to the safe default
    }
  }
  return installedVoicesCache.has(name)
}

/** Run a command to completion. Resolves with its exit code; never throws on
 *  a nonzero exit, because the caller decides what a given code means. */
function runToExit(cmd: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args)
    let stderr = ""
    proc.stderr?.on("data", (chunk) => { stderr += String(chunk) })
    proc.on("error", (error) => resolve({ code: null, stderr: String(error) }))
    proc.on("exit", (code) => resolve({ code, stderr: stderr.trim() }))
  })
}

async function readAndDelete(path: string): Promise<ArrayBuffer> {
  try {
    return await Bun.file(path).arrayBuffer()
  } finally {
    try { rmSync(path, { force: true }) } catch {}
  }
}

function tempPath(ext: string): string {
  return `/tmp/voice-local-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
}

/**
 * Synthesize speech locally. Tries say2 first, falls back to `say`.
 *
 * Returns the buffer plus the container format and the engine that produced it,
 * so the caller never has to guess. Throws only when BOTH engines fail — at that
 * point there is genuinely no way to speak.
 */
export async function generateLocalSpeech(text: string, voiceName?: string): Promise<LocalSpeechResult> {
  const config = loadLocalEngineConfig()

  if (config.preferSay2 && hasSay2()) {
    const out = tempPath("wav")
    const voice = voiceName || config.say2Voice
    const { code, stderr } = await runToExit("say2", [
      "synthesize", "-v", voice, "-r", String(config.say2RateWpm), "-o", out, text,
    ])

    if (code === 0) {
      return { audio: await readAndDelete(out), format: "wav", engine: "say2" }
    }

    try { rmSync(out, { force: true }) } catch {}
    if (code === SAY2_EXIT_FRAMEWORK_UNAVAILABLE) {
      console.error(
        `[Voice] say2 exit 69: the private Siri TTS framework is unavailable — most likely a macOS ` +
        `update removed or renamed it. This is permanent until say2 is updated. Falling back to \`say\`. ` +
        `Run \`say2 doctor\` to confirm.`,
      )
    } else {
      console.error(`[Voice] say2 failed (exit ${code}) — falling back to \`say\`. ${stderr}`)
    }
  }

  if (!hasSay()) {
    throw new Error("No local speech engine available (neither say2 nor say)")
  }

  let voice = config.sayVoice
  if (!isSayVoiceInstalled(voice)) {
    console.error(
      `[Voice] "${voice}" is not installed (System Settings → Accessibility → Read & Speak → ` +
      `System voice to download it) — using the system default voice instead`,
    )
    voice = ""
  }

  const out = tempPath("aiff")
  // `say` discards a [[slnc]] under ~265 ms entirely, so anything smaller here
  // is a silent no-op rather than a short pad.
  const embedded = config.sayWarmupSilenceMs > 0 ? `[[slnc ${config.sayWarmupSilenceMs}]]${text}` : text

  const args: string[] = []
  if (voice) args.push("-v", voice)
  if (config.sayRateWpm) args.push("-r", String(config.sayRateWpm))
  args.push("-o", out, embedded)

  const { code, stderr } = await runToExit("say", args)
  if (code !== 0) {
    try { rmSync(out, { force: true }) } catch {}
    throw new Error(`say exited with code ${code}${stderr ? `: ${stderr}` : ""}`)
  }

  return { audio: await readAndDelete(out), format: "aiff", engine: "say" }
}
