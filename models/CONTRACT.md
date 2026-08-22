# models

Purpose: the only place a model is configured. Tier isolation is the point: engine, agents, library and dreaming never learn which tier runs. Every agent asks this box for its model; no provider code exists anywhere else.

## Public API

Class `ModelGateway(tier=None)` (tier defaults to the `MODEL_TIER` env, default `cloud`).

| method | in | out |
|---|---|---|
| `model_for(role)` | `chat` or `dream` | an ADK model handle |
| `tier()` | | base tier (per-role env overrides not applied) |
| `probe()` async | | `bool`: the tier's model endpoint answers; local asks the llama.cpp server for its model list (2 s timeout, never raises), cloud and fake report True |

## Tiers

- `cloud` (deployment default): Gemini on Vertex AI. Env: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_GENAI_USE_VERTEXAI=TRUE`, `GEMINI_MODEL` (default `gemini-3.5-flash`).
- `local`: an OpenAI-compatible llama.cpp server serving Gemma. Env: `LOCAL_MODEL_URL`, `LOCAL_MODEL_ID`, optional `LOCAL_MODEL_KEY`. Needs the `mk-models[local]` extra (litellm).
- `fake`: `FakeLlm`, a deterministic in-process model for tests and offline dev. It recognizes the flow marker every prompt carries (`<!-- flow:name -->`: `say_route`, `keeper_tell`, `keeper_talk`, `keeper_ask`, `dark_keeper`, `monument`, `dream_write`, `dream_narrative`), emits valid JSON and real function calls, and reports estimated token usage. In the tell flow it also dispatches wired tools deterministically (a relative day such as "tomorrow" calls `resolve_date` first and the calendar date lands in the book; a YouTube link; lyrics, song, podcast, book/finished, movie keywords) and folds an ok result into the book body; a follow-up starting with a continuation cue that overlaps a shelved slug emits `extends_slug`, and a short remark opening with an opinion cue ("I liked", "I hate", ...) emits `note: true` with the overlapping slug in `about_slugs`, so capture, grow-the-book and the notes book prove out offline. The `dark_keeper` flow opens the first listed village book through `read_book`, then reflects on the theme and ends with a question, citing what it opened. The router mirrors the agents' wording fallback: a question asks, up to three words without a capture cue talk, the rest tells.

Tier selection: constructor arg, else `MODEL_TIER`; per-role override `MODEL_TIER_CHAT` / `MODEL_TIER_DREAM`.

## Errors (closed set)

`ModelsError` (`PROVIDER_UNAVAILABLE`): unknown tier or missing local extra. The base tier is checked at construction; a bad per-role override or missing extra raises on the first `model_for` call, never silently falls through to another tier.

## Invariants

- No output length caps, ever: no max token parameter is set by this box or accepted from callers.
- Credentials only via env / application default credentials; nothing on disk in the repo.
- Callers never see provider classes, only the handle from `model_for`.
- The fake tier is deterministic: same request in, same response out.
