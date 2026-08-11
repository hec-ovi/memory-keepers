# agy

Purpose: the machinery of the `agy` model tier: any MCP-capable CLI becomes the island's brain, for people who can run neither Gemma nor a cloud key.

## Shape

Two pieces, one process each:

- **Broker** (`mk_agy.broker`, FastAPI, port 8765): an in-memory job queue between the model gateway (producer) and a serving CLI (consumer). Jobs live only while the process does.
- **MCP toolkit** (`mk_agy.mcp_server`, stdio): the two tools a CLI loops on. Env `AGY_BROKER_URL` (default `http://localhost:8765`).

## Broker routes

| route | in | out |
|---|---|---|
| `POST /jobs` | `{prompt}` | 201 `{job_id}` |
| `GET /jobs/next?wait=` | | `{job_id, prompt}` (claims) or `{idle: true}` after the wait (capped 30 s) |
| `GET /jobs/{id}?wait=` | | `{status: pending\|claimed\|done\|unknown, reply}`; wait long-polls for done |
| `POST /jobs/{id}/reply` | `{text}` | `{ok}`; `{ok: false, reason: unknown_job}` |
| `GET /health` | | `{status, pending}` |

## MCP tools

- `serve_next_model_job()` -> `{job_id, prompt}` or `{idle: true}`; blocks up to ~30 s, the CLI calls it in a loop (this is what dedicates the CLI to the island).
- `submit_model_reply(job_id, text)` -> `{ok}`.

## Running the mode

```
MODEL_TIER=agy docker compose --profile agy up
```

then register `agy/src/mk_agy/mcp_server.py` in the CLI's MCP config and tell it to serve the island. The prompt each job carries is self-describing (instruction, tool protocol, conversation); the CLI just answers it.

## Invariants

- This box knows nothing about keepers, worlds or models: it moves prompts and replies, verbatim.
- No auth: the broker binds inside the compose network / localhost; it must never be exposed publicly.
- A vanished CLI never breaks the game: the gateway's agy tier times out and every agent flow falls back deterministically (the models contract).

## How to test

`docker compose run --rm test /opt/venv/bin/pytest agy -q`: the job lifecycle over the real ASGI app and the toolkit verbs against the broker protocol.
