# models

Purpose: the only place a model is configured. Every agent asks this box for its model; no provider code exists anywhere else.

## Public API

Class `ModelGateway(tier=None)` (tier defaults to the `MODEL_TIER` env, default `cloud`).

| method | in | out |
|---|---|---|
| `model_for(role)` | `chat` or `dream` | an ADK model handle |
| `tier()` | | active tier |

## Tiers

- `cloud` (deployment default): Gemini on Vertex AI. Env: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_GENAI_USE_VERTEXAI=TRUE`, `GEMINI_MODEL` (default `gemini-3.5-flash`).
- `local`: an OpenAI-compatible llama.cpp server serving Gemma. Env: `LOCAL_MODEL_URL`, `LOCAL_MODEL_ID`, optional `LOCAL_MODEL_KEY`. Needs the `mk-models[local]` extra (litellm).
- `fake`: `FakeLlm`, a deterministic in-process model for tests and offline dev. It recognizes the flow marker every prompt carries (`<!-- flow:name -->`: `keeper_tell`, `keeper_ask`, `monument`, `dream_write`, `dream_narrative`), emits valid JSON and real function calls, and reports estimated token usage.

Tier selection: constructor arg, else `MODEL_TIER`; per-role override `MODEL_TIER_CHAT` / `MODEL_TIER_DREAM`.

## Errors (closed set)

`ModelsError` (`PROVIDER_UNAVAILABLE`): unknown tier or missing local extra; raised at construction, never mid-game.

## Invariants

- No output length caps, ever: no max token parameter is set by this box or accepted from callers.
- Credentials only via env / application default credentials; nothing on disk in the repo.
- Callers never see provider classes, only the handle from `model_for`.
- The fake tier is deterministic: same request in, same response out.
