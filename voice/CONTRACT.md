# voice

Purpose: speech in and out for the dialogs. One FastAPI router the engine mounts under `/voice`.

## Public API

| route | in | out |
|---|---|---|
| `POST /voice/tts` | `{text, keeper_id?}` | `audio/ogg` bytes, a voice per keeper kind (light, dark, monument) |
| `POST /voice/stt` | `audio/webm` or `audio/ogg` body | `{text}` |

Backed by Cloud Text-to-Speech and Speech-to-Text; credentials via application default credentials.

## Errors (closed set)

`VOICE_UNAVAILABLE` (503): APIs not reachable or not configured. The frontend falls back to text-only dialogs; the game never depends on voice.

## Invariants

- No audio is stored anywhere; requests are transient.
- Voice selection is deterministic per keeper kind, so a keeper always sounds like herself.
