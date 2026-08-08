# CONTRACT: frontend/src/api (engine client)

Purpose: the ONE module that talks to the engine. Transport-agnostic: fetch
against the REST API today, an transport-style `invoke` function later, same
surface either way (see `harness/contract.md` "Plug-in plan"). No other file
in `frontend/src` may call `fetch`. The route/shape source of truth is
`docs/api.md`.

## Public API (exact signatures)

```js
import { createApi, ApiError } from "./api/api.js";

createApi({ baseUrl = "", invoke = null, fetchFn = (...args) => globalThis.fetch(...args), sleep = defaultSleep } = {}) -> api
```

- `baseUrl` REST prefix, trailing slashes stripped; `""` = same origin.
- `invoke(path, {method, body}) -> Promise<raw>` transport transport; wins over
  `baseUrl` when both are given.
- `fetchFn` / `sleep` injectable for tests (`sleep(ms) -> Promise`).

`api` methods (all return a Promise of the peeled JSON payload, all reject
with `ApiError`):

```js
request(path, { method = "GET", body } = {})   // escape hatch; prefer wrappers
health()                                       // GET /health
getState()                                     // GET /state
createKeeper({ topic, name, persona } = {})      // POST /keepers (name/persona sent only when defined)
listKeepers()                                    // GET /keepers
getKeeper(keeperId)                                // GET /keepers/{id}
deleteKeeper(keeperId)                             // DELETE /keepers/{id}
tell(keeperId, text)                             // POST /keepers/{id}/tell {text}
ask(keeperId, question)                          // POST /keepers/{id}/ask {question}
getChatter(keeperId)                             // GET /keepers/{id}/chatter
sleep(keeperId)                                  // POST /keepers/{id}/sleep {} -> 202 {job_id}
sleepJob(keeperId, jobId)                        // GET /keepers/{id}/sleep/{jobId} -> {status}
listBooks(keeperId)                              // GET /keepers/{id}/books
getBook(keeperId, slug)                          // GET /keepers/{id}/books/{slug}
deleteBook(keeperId, slug)                       // DELETE /keepers/{id}/books/{slug}
consolidate()                                  // POST /consolidate {}
getLatestConsolidation()                       // GET /consolidations/latest
getConsolidation(runId)                        // GET /consolidations/{runId}
seed()                                         // POST /dev/seed {}
reset()                                        // POST /dev/reset {}
```

Path params go through `encodeURIComponent`.

```js
class ApiError extends Error { name = "ApiError"; status; code; message }
```

`status` 0 means network/transport-level failure. `code` comes from the
engine error body (`docs/api.md` symbols like `KEEPER_EXISTS`, `KEEPERS_FULL`,
`NEEDS_SLEEP`, `SLEEP_RUNNING`), or `NETWORK`, `BAD_RESPONSE` (non-JSON
body), `SERVER_ERROR` (5xx without a code), `UNKNOWN`.

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
- Bodies are JSON; `content-type: application/json` is set only when a body
  is present.
- 4xx errors are never retried and keep the engine's `code`/`message`.
- Swapping REST for invoke changes only the `createApi` options, never the
  method surface.

## How to test

`cd frontend && npx vitest run tests/api.test.js` (24 tests; MSW at the
network layer, injected no-op sleep). Covers peeling of all three envelope
shapes, error mapping, GET retry/backoff, non-retry of POST/DELETE, the
sleep endpoints, and round-5 field passthrough.
