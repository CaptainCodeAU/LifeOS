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
 */

import { spawn } from "child_process"
import { rmSync } from "fs"

const DEFAULT_VOICE = "Samantha"
// Requirement 2: some Bluetooth/AirPlay speakers clip the first ~200-400ms
// while they wake from idle. `[[slnc N]]` is a `say`-only embedded command
// (silent on other engines, which is exactly why this lives here and not in
// the shared sanitizeForSpeech/generateSpeech path both engines go through).
const WARMUP_SILENCE_MS = 450

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

  const voice = voiceName || DEFAULT_VOICE
  const tempFile = `/tmp/voice-local-${Date.now()}-${Math.random().toString(36).slice(2)}.aiff`
  const embeddedText = `[[slnc ${WARMUP_SILENCE_MS}]]${text}`

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("say", ["-v", voice, "-o", tempFile, embeddedText])

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
