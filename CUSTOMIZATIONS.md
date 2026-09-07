# CUSTOMIZATIONS — every upstream file Gavin has edited, and why

Tracked here per the fork strategy: upstream squashes an entire release into one
commit with no per-feature history (see `cleaner_temp/Plans/i-m-liking-almost-all-mossy-shamir-agent-afork-designer-f97cfb5f18803e27.md`
Part 1), so before every merge, `comm -12` between what upstream touched and what's
listed here tells you in advance which of these will actually conflict.

## Upstream files edited

| File | What changed | Why not an extension point instead | What would let it move |
|---|---|---|---|
| `LIFEOS/install/LIFEOS/PULSE/VoiceServer/voice.ts` | Added an `else if` branch in `sendNotification()`: when no ElevenLabs key is configured, calls the new local engine (`gk-localSay.ts`) instead of going silent. Also raised `RATE_LIMIT` 10→300 (never silently drop a notification). | `sendNotification` is the one place that knows whether the paid path succeeded — the branch has to live here. Kept to the smallest possible diff: one `else if` block, the engine itself lives entirely in a new file. | If upstream ever ships its own local-engine hook point, this branch could shrink to a single call into it. |
| `LIFEOS/install/hooks/lib/output-validators.ts` | `getVoiceFallback()` now returns `'Done.'` instead of `''`. One line. | This is the exact function upstream defines for this purpose — no alternate location exists. | N/A — this is already the correct extension point, just the wrong default. |
| `LIFEOS/install/hooks/handlers/VoiceNotification.ts` | One import + one call site (`playMalformedChime()`) added right where the fallback already triggers. | Needs to fire exactly when validation fails, which only `handleVoice` knows. | Already minimal — a single line calling into a new file. |

## New files (upstream ships nothing at these paths — never conflict, never touched by an update)

- `LIFEOS/install/LIFEOS/PULSE/VoiceServer/gk-localSay.ts` — the free local speech engine (macOS `say`), used whenever the ElevenLabs API key isn't configured. Also carries the device-warm-up silence prefix (`[[slnc 450]]`) since that's a `say`-only directive.
- `LIFEOS/install/hooks/lib/gk-chime.ts` — plays a short system sound when a response failed validation, independent of the TTS pipeline (a chime isn't speech, so it doesn't need the voice server or an API key).

## Context

All landed 2026-09-08 on `feat/voice-requirements`, implementing the seven voice
requirements from `cleaner_temp/FINDINGS.md` §2 against a version of LifeOS that ships
no local TTS engine at all (upstream only calls ElevenLabs). Full requirement-by-requirement
mapping: `cleaner_temp/Plans/i-m-liking-almost-all-mossy-shamir-agent-afork-designer-f97cfb5f18803e27.md`
Part 7.
