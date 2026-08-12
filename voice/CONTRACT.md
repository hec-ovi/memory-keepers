# voice

Purpose: speech in and out for the dialogs. One FastAPI router the engine mounts under `/voice`.

## Public API

| route | in | out |
|---|---|---|
| `POST /voice/tts` | `{text, kind?}` with kind `light` (default), `dark` or `monument` | `audio/ogg` bytes, one fixed voice per kind |
| `POST /voice/stt` | `audio/webm` or `audio/ogg` body (opus; the Content-Type header picks the decoder) | `{text}` |

Backed by Cloud Text-to-Speech and Speech-to-Text; credentials via application default credentials. STT runs the `latest_short` model with automatic punctuation, language `en-US`; the per-kind voice names are constants in `router.py`.

`create_voice_router(tts_client=None, stt_client=None)` builds the router (clients injectable for tests). `unavailable_router()` serves the same routes always answering 503; the engine mounts it when `VOICE=off`.

## Errors (closed set)

`VOICE_UNAVAILABLE` (503): APIs not reachable or not configured. The frontend falls back to text-only dialogs; the game never depends on voice.

`VALIDATION` (422): empty text (tts) or empty audio body (stt).

## Invariants

- No audio is stored anywhere; requests are transient.
- Voice selection is deterministic per keeper kind, so a keeper always sounds like herself.
