/**
 * Requirement 7 (malformed response audibly distinct): play a short system
 * chime when a response failed validation, so a bad completion sounds
 * different from a normal one instead of silently getting the same "Done."
 * fallback speech. New file at a path upstream never ships — never touched
 * by an update, never conflicts on merge (see Tools/InstallEngine.ts's
 * "same relative path" overlay contract).
 *
 * Fire-and-forget, independent of the TTS/HTTP pipeline: a chime isn't
 * speech, so it doesn't need the voice server, an API key, or the local
 * engine — it plays directly, best-effort, and never throws.
 */

import { spawn } from "child_process";

// Same resolve-once-by-Bun.which pattern voice.ts's resolveAudioPlayer uses,
// so a missing player is detected up front instead of discovered via a
// swallowed async spawn "error" event.
const CANDIDATES: Array<{ cmd: string; args: string[] }> =
  process.platform === "darwin"
    ? [{ cmd: "afplay", args: ["/System/Library/Sounds/Sosumi.aiff"] }]
    : [
        { cmd: "paplay", args: ["/usr/share/sounds/freedesktop/stereo/dialog-warning.oga"] },
        { cmd: "aplay", args: ["/usr/share/sounds/alsa/Front_Center.wav"] },
      ];

let resolved: { path: string; args: string[] } | null | undefined = undefined;

function resolveChimePlayer(): { path: string; args: string[] } | null {
  if (resolved !== undefined) return resolved;
  for (const c of CANDIDATES) {
    const path = Bun.which(c.cmd);
    if (path) {
      resolved = { path, args: c.args };
      return resolved;
    }
  }
  resolved = null;
  return resolved;
}

export function playMalformedChime(): void {
  const player = resolveChimePlayer();
  if (!player) return; // no known player on this platform — silent no-op, never throws
  const proc = spawn(player.path, player.args, { stdio: "ignore" });
  proc.on("error", () => {}); // best-effort; a failed chime must never break the fallback speech
}
