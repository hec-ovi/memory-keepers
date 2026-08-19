# engine

Purpose: the HTTP surface and the world bookkeeping. FastAPI app on Cloud Run; serves the frontend statics and the JSON API; owns meters, caps, jobs and world scoping. No model call and no Firestore access happens here directly, only through agents and library. The engine constructs the lookups box and hands it to agents; env `OMDB_KEY` (optional) enriches movie lookups.

## World scoping

The frontend sends `X-World: <id>` (generated once, kept in localStorage). First touch of a world seeds demo keepers and books, so every visitor lands on a living island.

## Routes

| route | in | out |
|---|---|---|
| `GET /health` | | `{status, version, tier, model}`: the gateway probe answers `model: ok\|down`, and a dead model endpoint makes status `degraded` (the frontend refuses to boot on it) |
| `GET /state` | | `{keepers: [Keeper], dream: {latest_run_id, running}}`, one call boots the UI |
| `POST /keepers` | `{topic, name?, persona?}` | Keeper (201); 409 `KEEPER_EXISTS` / `KEEPERS_FULL` |
| `GET /keepers` / `GET /keepers/{id}` | | Keeper list / one |
| `DELETE /keepers/{id}` | | `{deleted: true}` (dark keepers too); 409 `SLEEP_RUNNING` while she sleeps |
| `POST /keepers/{id}/say` | `{text}` | the model routes to tell or ask; that flow's response plus `{kind, session}`; same 409s |
| `POST /keepers/{id}/tell` | `{text}` | `{reply, book?, book_grown?, session}`; 409 `LIBRARY_FULL` / `NEEDS_SLEEP` / `SLEEP_RUNNING` |
| `POST /keepers/{id}/ask` | `{question}` | `{answer, sources, grounded, followup, session}`; same 409s |
| `GET /keepers/{id}/books` / `GET .../books/{slug}` | | summaries newest first / full book |
| `DELETE /keepers/{id}/books/{slug}` | | `{deleted: true}` |
| `GET /keepers/{id}/chatter` | | `{line}` (short bubble text) |
| `POST /keepers/{id}/sleep` | `{}` | 202 `{job_id, status}`; 409 `SLEEP_RUNNING`; poll `GET .../sleep/{job_id}` (404 `SLEEP_NOT_FOUND`) |
| `POST /monument` | `{text}` | `{reply, created_keeper?}` (the root agent) |
| `POST /dream` | `{}` | 202 `{status: queued, run_id}`; 409 `DREAM_RUNNING`; watch `/dreams/{run_id}` |
| `GET /dreams/latest` / `GET /dreams/{run_id}` | | dream report with graph and narrative |
| `GET /world/export` | | the whole world as one portable JSON (library `export_world`) |
| `POST /world/import` | a world export file | 201 `{world, keepers, books}`: a fresh crypto world id holding the file's content; 422 `IMPORT_INVALID` |
| `POST /internal/dream-run?token=` | Pub/Sub push envelope | runs the dream in-request; token-gated |
| `POST /internal/nightly?token=` | | dispatches a dream for every world (Cloud Scheduler target) |

Internal routes answer 403 unless env `INTERNAL_TOKEN` is set and matches the `token` query param.
| `POST /voice/tts` | `{text, kind?}` | `audio/ogg` (voice box; 503 `VOICE_UNAVAILABLE` when unconfigured) |
| `POST /voice/stt` | audio body | `{text}` (voice box) |

Voice mounts the real Cloud TTS/STT router by default (credentials via ADC, per-request degrade to 503); env `VOICE=off` mounts the always-503 stub for offline dev and tests.
| `POST /dev/seed` | `{}` | `{seeded, keepers, books}`; touches the world so demo content seeds (the HUD "Demo data" button); always mounted |
| `POST /dev/reset` | `{}` | only with `DEV_ROUTES=1`, absent in deployment |

Errors are `{"error": {"code": SYMBOL, "message": str}}`. Closed set: the library symbols plus `SLEEP_NOT_FOUND`, `NEEDS_SLEEP`, `SLEEP_RUNNING`, `DREAM_RUNNING`, `VALIDATION`, `VOICE_UNAVAILABLE`, `ACCESS_REQUIRED`.

With env `ACCESS_CODE` set, every API route (not /health, statics, or /internal) answers 401 `ACCESS_REQUIRED` unless the request carries `X-Access-Code: <code>`; anonymous traffic never reaches a model or speech service.

Statics are served `Cache-Control: no-cache` (etag revalidation, 304s): the SPA has no build step, so browsers must revalidate modules on every load or ship stale UI.

## Bookkeeping owned here

- **Tiredness meter.** Adds agent-reported tokens per tell/ask into the library meter. Status: `rested < 0.70 <= unrested < 0.85 <= needs_sleep` of the session budget (env `SESSION_TOKEN_BUDGET`, default 32000). At `needs_sleep`, tell/ask return 409 until she sleeps, and a tired-keeper dream event is published.
- **Sleep.** Background job per keeper: constraints carry over verbatim, the last user texts land in the `recent_topics` block, the last 3 turns stay verbatim; dropped detail lands as `sleep` books, meter resets to the compacted session's size. At the 24-book cap the two oldest `told`/`sleep` books merge into one digest book first, so nothing is ever lost and a slot stays free.
- **Levels.** Derived from book count, returned on every Keeper payload.
- **Jobs.** Slow work is 202 + poll; no streaming, no server push.

## Invariants

- Deterministic fallbacks everywhere: a model failure never breaks tell, ask or sleep; only chatter may degrade to a silent skip.
- The engine adds no game rules to the frontend payloads; the frontend adds no memory logic.
