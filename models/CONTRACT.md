# models

Purpose: the only place a model is configured. Every agent asks this box for its model; no provider code exists anywhere else.

## Public API

| method | in | out |
|---|---|---|
| `model_for(role)` | `chat | dream | chatter` | an ADK-compatible model handle |
| `tier()` | | active tier: `cloud` or `local` |

## Tiers

- `cloud` (default in deployment): Gemini on Vertex AI. Project, region and model id come from env (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GEMINI_MODEL`).
- `local`: an OpenAI-compatible llama.cpp server (`LOCAL_MODEL_URL`, `LOCAL_MODEL_ID`), serving Gemma. Same interface, zero code change above this box.

Tier selection: `MODEL_TIER` env, per-role override `MODEL_TIER_<ROLE>`.

## Errors (closed set)

`PROVIDER_UNAVAILABLE` (bad config or unreachable endpoint; surfaced at startup, not mid-game).

## Invariants

- No output length caps, ever: no max token parameter is set by this box or accepted from callers.
- Credentials only via env / application default credentials; nothing on disk in the repo.
- Callers never see provider types, only the handle from `model_for`.
