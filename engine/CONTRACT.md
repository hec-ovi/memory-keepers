# engine

Purpose: the HTTP surface and the world bookkeeping. FastAPI app on Cloud Run; serves the frontend statics and the JSON API; owns meters, caps, jobs and world scoping. No model call and no Firestore access happens here directly, only through agents and library.

## World scoping

The frontend sends `X-World: <id>` (generated once, kept in localStorage). First touch of a world seeds demo keepers and books, so every visitor lands on a living island.

## Routes

| route | in | out |
|---|---|---|
| `GET /health` | | `{status, version, tier}` |
| `GET /state` | | `{keepers: [Keeper], dream: {latest_run_id, running}}`, one call boots the UI |
| `POST /keepers` | `{topic, name?, persona?}` | Keeper (201); 409 `KEEPER_EXISTS` / `KEEPERS_FULL` |
| `GET /keepers` / `GET /keepers/{id}` | | Keeper list / one |
| `DELETE /keepers/{id}` | | `{deleted: true}` (dark keepers too) |
| `POST /keepers/{id}/tell` | `{text}` | `{reply, book?, session}`; 409 `LIBRARY_FULL` / `NEEDS_SLEEP` / `SLEEP_RUNNING` |
| `POST /keepers/{id}/ask` | `{question}` | `{answer, sources, grounded, followup, session}`; same 409s |
| `GET /keepers/{id}/books` / `GET .../books/{slug}` | | summaries newest first / full book |
| `DELETE /keepers/{id}/books/{slug}` | | `{deleted: true}` |
| `GET /keepers/{id}/chatter` | | `{line}` (short bubble text) |
| `POST /keepers/{id}/sleep` | `{}` | 202 `{job_id}`; poll `GET .../sleep/{job_id}` |
| `POST /dream` | `{}` | 202 `{run_id}` (publishes the Pub/Sub event) |
| `GET /dreams/latest` / `GET /dreams/{run_id}` | | dream report with graph and narrative |
| `POST /voice/tts` | `{text}` | audio (mounted from the voice box) |
| `POST /voice/stt` | audio | `{text}` (mounted from the voice box) |
| `POST /dev/seed` / `POST /dev/reset` | `{}` | dev only, disabled in deployment |

Errors are `{"error": {"code": SYMBOL, "message": str}}`. Closed set: the library symbols plus `NEEDS_SLEEP`, `SLEEP_RUNNING`, `DREAM_RUNNING`, `VALIDATION`, `VOICE_UNAVAILABLE`.

## Bookkeeping owned here

- **Tiredness meter.** Adds agent-reported tokens per tell/ask into the library meter. Status: `rested < 0.70 <= unrested < 0.85 <= needs_sleep` of the session budget (env `SESSION_TOKEN_BUDGET`, default 12000). At `needs_sleep`, tell/ask return 409 until she sleeps, and a tired-keeper dream event is published.
- **Sleep.** Background job per keeper: session compacts into fixed summary blocks (constraints copied verbatim, last turns kept), dropped detail lands as `sleep` books, meter resets. At the 24-book cap the two oldest `told`/`sleep` books merge into one digest book first, so nothing is ever lost and a slot stays free.
- **Levels.** Derived from book count, returned on every Keeper payload.
- **Jobs.** Slow work is 202 + poll; no streaming, no server push.

## Invariants

- Deterministic fallbacks everywhere: a model failure never breaks tell, ask or sleep; only chatter may degrade to a silent skip.
- The engine adds no game rules to the frontend payloads; the frontend adds no memory logic.
