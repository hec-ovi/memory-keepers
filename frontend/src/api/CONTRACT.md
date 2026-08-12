# CONTRACT: frontend/src/api (engine client)

Purpose: the ONE module that talks to the engine. Transport-agnostic: fetch
against the REST API today, a transport-style `invoke` function later, same
surface either way. No other file in `frontend/src` may call `fetch`. The
route/shape source of truth is the engine's contract (`engine/CONTRACT.md`
at the repo root).

## Public API (exact signatures)

```js
import { createApi, ApiError } from "./api/api.js";

createApi({ baseUrl = "", invoke = null, worldId = null, fetchFn = (...args) => globalThis.fetch(...args), sleep = defaultSleep } = {}) -> api
```

- `baseUrl` REST prefix, trailing slashes stripped; `""` = same origin.
- `invoke(path, {method, body}) -> Promise<raw>` alternate transport; wins
  over `baseUrl` when both are given.
- `worldId` use this world id for the session; when null it comes from
  localStorage "mk-world" (minted once per browser, `worldIdFrom`).
- `fetchFn` / `sleep` injectable for tests (`sleep(ms) -> Promise`).

`api` methods (all return a Promise of the peeled JSON payload, all reject
with `ApiError`):

```js
request(path, { method = "GET", body } = {})   // escape hatch; prefer wrappers
health()                                       // GET /health (no UI caller today)
getState()                                     // GET /state
createKeeper({ topic, name, persona } = {})      // POST /keepers (name/persona sent only when defined)
listKeepers()                                    // GET /keepers (no UI caller today)
getKeeper(keeperId)                                // GET /keepers/{id}
deleteKeeper(keeperId)                             // DELETE /keepers/{id} (no UI caller today)
tell(keeperId, text)                             // POST /keepers/{id}/tell {text}
ask(keeperId, question)                          // POST /keepers/{id}/ask {question}
getChatter(keeperId)                             // GET /keepers/{id}/chatter
sleep(keeperId)                                  // POST /keepers/{id}/sleep {} -> 202 {job_id}
sleepJob(keeperId, jobId)                        // GET /keepers/{id}/sleep/{jobId} -> {status}
listBooks(keeperId)                              // GET /keepers/{id}/books
getBook(keeperId, slug)                          // GET /keepers/{id}/books/{slug}
deleteBook(keeperId, slug)                       // DELETE /keepers/{id}/books/{slug}
consolidate()                                  // POST /dream {} -> {status, run_id}
getLatestConsolidation()                       // GET /dreams/latest
getConsolidation(runId)                        // GET /dreams/{runId}
monument(text)                                 // POST /monument {text}
stt(blob)                                      // POST /voice/stt (raw opus body) -> {text}
tts(text, kind = "light")                      // POST /voice/tts {text, kind} -> audio Blob
setAccessCode(code)                            // remember the island key (localStorage "mk-access"); sent as X-Access-Code on every call; falsy clears it
setWorldId(id)                                 // adopt a world id (localStorage "mk-world"); the next page load talks to that world; falsy clears it
exportWorld()                                  // GET /world/export -> the island as one JSON
importWorld(data)                              // POST /world/import -> {world, keepers, books}; caller adopts the fresh id
seed()                                         // POST /dev/seed {}
reset()                                        // POST /dev/reset {} (no UI caller today)
```

The `(no UI caller today)` methods mirror real engine routes and serve tests
and dev tooling; they stay on the surface so the client covers the whole
engine contract.

Path params go through `encodeURIComponent`.

Voice speaks raw bytes (`voice/CONTRACT.md`), so `stt`/`tts` bypass the JSON
envelope peeling: fetch transport only (never `invoke`), same `X-World`
header, no retry. `stt` sends the blob with the blob's own `type` as
content-type (`audio/webm` fallback); `tts` resolves the response as a Blob
(`kind`: `"light" | "dark" | "monument"`). Failures reject with the same
`ApiError` mapping; a 503 carries the engine's `VOICE_UNAVAILABLE` code.

```js
class ApiError extends Error { name = "ApiError"; status; code; message }
```

`status` 0 means network/transport-level failure. `code` comes from the
engine error body (`engine/CONTRACT.md` symbols like `KEEPER_EXISTS`, `KEEPERS_FULL`,
`NEEDS_SLEEP`, `SLEEP_RUNNING`, `VOICE_UNAVAILABLE`), or `NETWORK`,
`BAD_RESPONSE` (non-JSON body), `SERVER_ERROR` (5xx without a code),
`UNKNOWN`.

Round-5 payload fields pass through untouched: `ask` resolves the full
`{answer, sources, grounded, followup}` body, Keeper objects keep `level` and
`session {tokens_used, budget, status}`. The client never strips fields.

## Envelope peeling

One internal `peel(status, raw)` unwraps, in a loop (max depth 8):

1. SDK: `{ok: true, result}` (failure `{ok: false, error: {code, message}}`)
2. transport: `{success: true, data: {status, json}}` or `{success, data}`
   (an envelope-carried `data.status` replaces the outer HTTP status)
3. bare JSON

Any failure shape or final status >= 400 throws `ApiError`.

## Retry policy

GET retries up to 3 extra times, backoff 250/500/1000 ms via the injectable
`sleep`, only on retryable failures (status 0 or >= 5xx). POST/DELETE never
retry.

## Bus events

None. The client is bus-free; callers (ui/, main.js) emit their own events
after api calls resolve.

## Invariants

- No `fetch` outside this module (architecture rule 3).
- Bodies are JSON (`content-type: application/json` set only when a body is
  present), except the voice routes, whose bodies and/or responses are raw
  audio bytes.
- 4xx errors are never retried and keep the engine's `code`/`message`.
- Swapping REST for invoke changes only the `createApi` options, never the
  method surface (voice stays on fetch either way).

## How to test

`cd frontend && npx vitest run tests/api.test.js` (29 tests; MSW at the
network layer, injected no-op sleep). Covers peeling of all three envelope
shapes, error mapping, GET retry/backoff, non-retry of POST/DELETE, the
sleep endpoints, round-5 field passthrough, and the voice routes.
