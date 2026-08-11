# models

Purpose: the only place a model is configured. Tier isolation is the point: engine, agents, library and dreaming never learn which tier runs. Every agent asks this box for its model; no provider code exists anywhere else.

## Public API

Class `ModelGateway(tier=None)` (tier defaults to the `MODEL_TIER` env, default `cloud`).

| method | in | out |
|---|---|---|
| `model_for(role)` | `chat` or `dream` | an ADK model handle |
| `tier()` | | active tier |

## Tiers

- `cloud` (deployment default): Gemini on Vertex AI. Env: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_GENAI_USE_VERTEXAI=TRUE`, `GEMINI_MODEL` (default `gemini-3.5-flash`).
- `local`: an OpenAI-compatible llama.cpp server serving Gemma. Env: `LOCAL_MODEL_URL`, `LOCAL_MODEL_ID`, optional `LOCAL_MODEL_KEY`. Needs the `mk-models[local]` extra (litellm).
- `agy`: completions served by whatever MCP-capable CLI is attached to the mk-agy broker (the agy box's contract). The whole ADK request flattens into one self-describing prompt; the CLI answers with text or a `{"tool_call": ...}` JSON. Env: `AGY_BROKER_URL`, `AGY_TIMEOUT_S` (default 180; a timeout raises and the agent flows fall back). Needs the `mk-models[agy]` extra (httpx).
- `fake`: `FakeLlm`, a deterministic in-process model for tests and offline dev. It recognizes the flow marker every prompt carries (`<!-- flow:name -->`: `keeper_tell`, `keeper_ask`, `monument`, `dream_write`, `dream_narrative`), emits valid JSON and real function calls, and reports estimated token usage. In keeper flows it also dispatches wired lookup tools deterministically (a YouTube link, the word song, the word movie) and folds an ok result into the book body, so the whole lookup loop proves out offline.

Tier selection: constructor arg, else `MODEL_TIER`; per-role override `MODEL_TIER_CHAT` / `MODEL_TIER_DREAM`.

## Errors (closed set)

`ModelsError` (`PROVIDER_UNAVAILABLE`): unknown tier or missing local extra. The base tier is checked at construction; a bad per-role override or missing extra raises on the first `model_for` call, never silently falls through to another tier.

## Invariants

- No output length caps, ever: no max token parameter is set by this box or accepted from callers.
- Credentials only via env / application default credentials; nothing on disk in the repo.
- Callers never see provider classes, only the handle from `model_for`.
- The fake tier is deterministic: same request in, same response out.
