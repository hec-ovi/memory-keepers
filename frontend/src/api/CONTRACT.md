# frontend / api client

Purpose: the one engine client; no fetch exists anywhere else in the game.

`createApi({baseUrl, worldId, fetchFn?})` returns thin methods over every engine route (state, keepers, tell/ask/chatter, monument, books, sleep, dream, tts/stt). Every request carries `X-World`. Failures become `ApiError{status, code, message}` with the engine's symbol; GETs retry up to 3 times on 5xx, writes never retry. `worldIdFrom(storage)` mints and persists the world id.

Test: `docker compose run --rm test-frontend` (tests/api.test.js).
