# models

Purpose: the only place a model is configured. Tier isolation is the point: engine, agents, library and dreaming never learn which tier runs. Every agent asks this box for its model; no provider code exists anywhere else.

## Public API

Class `ModelGateway(tier=None)` (tier defaults to the `MODEL_TIER` env, default `local`).

| method | in | out |
|---|---|---|
| `model_for(role)` | `chat` or `dream` | a chat model (below) for the role's tier |
| `tier()` | | base tier (per-role env overrides not applied) |
| `probe()` async | | `bool`: the tier's model endpoint answers; local asks the server for its model list (`GET {LOCAL_MODEL_URL}/models`, 2 s timeout, never raises), fake reports True |

A chat model has one method:

`async complete(messages, tools=()) -> Reply`

- `messages`: OpenAI chat-completions messages (`system`, `user`, `assistant` with optional `tool_calls`, `tool` with `tool_call_id`), content as strings.
- `tools`: OpenAI function-tool schemas (`{"type": "function", "function": {name, description, parameters}}`); empty means a plain completion.

`Reply` (frozen dataclass, exported with `ToolCall`):

| field | type | meaning |
|---|---|---|
| `text` | `str` | the assistant's text, reasoning removed; `""` when it only called tools |
| `tool_calls` | `tuple[ToolCall, ...]` | `ToolCall(id, name, arguments)`; `arguments` is the decoded `dict`, or `None` when the model's arguments did not decode to a JSON object |
| `tokens` | `int` | the call's total token count (prompt plus completion); 0 when the server reports none |

`Reply.message()` returns the reply as the assistant message for the next request (tool calls re-encoded as JSON strings, `{}` for undecodable arguments).

## Tiers

- `local` (default): plain `httpx` POST to `{LOCAL_MODEL_URL}/chat/completions` with `{model, messages, tools?}`. Env: `LOCAL_MODEL_URL` (default `http://127.0.0.1:8080/v1`), `LOCAL_MODEL_ID` (default `qwen3.6-35b-a3b`), optional `LOCAL_MODEL_KEY` (sent as `Authorization: Bearer` only when set). It targets llama.cpp `llama-server --jinja` serving Qwen3.6-35B-A3B; any OpenAI-compatible server works. A reasoning block at the head of `content` (`<think>...</think>`, or text up to a bare `</think>`) is stripped and `reasoning_content` is ignored. Request timeout 600 s (connect 10 s): local generation is slow.
- `fake`: `FakeModel`, a deterministic in-process model for tests and offline dev. It recognizes the flow marker every prompt carries (`<!-- flow:name -->`: `say_route`, `keeper_tell`, `keeper_talk`, `keeper_ask`, `dark_keeper`, `monument`, `dream_select` (every listed key in the human bucket), `dream_write`, `dream_narrative`), emits valid JSON and real tool calls, and reports estimated token usage (characters / 4). It reads tool results from `tool` messages, naming each through the assistant `tool_calls` that asked for it. In the tell flow it also dispatches offered tools deterministically (a relative day such as "tomorrow" calls `resolve_date` first and the calendar date lands in the book; lyrics, song, podcast, book/finished, movie keywords) and folds an ok result into the book body; a follow-up starting with a continuation cue that overlaps a shelved slug emits `extends_slug`, and a short remark opening with an opinion cue ("I liked", "I hate", ...) emits `note: true` with the overlapping slug in `about_slugs`, so capture, grow-the-book and the notes book prove out offline. The `dark_keeper` flow opens the first listed village book through `read_book`, then reflects on the theme and ends with a question, citing what it opened. The `monument` flow calls `create_keeper` for "a new keeper for X", or the `ask_<keeper>` tool whose shelf the message names. The router mirrors the agents' wording fallback: a question asks, up to three words without a capture cue talk, the rest tells.

Tier selection: constructor arg, else `MODEL_TIER`; per-role override `MODEL_TIER_CHAT` / `MODEL_TIER_DREAM`.

## Errors (closed set)

`ModelsError` (`PROVIDER_UNAVAILABLE`): an unknown tier, or a local call that fails (server unreachable, error status, unreadable reply). The base tier is checked at construction; a bad per-role override raises on the first `model_for` call, never silently falls through to another tier.

## Invariants

- No output length caps, ever: no max token parameter is set by this box or accepted from callers.
- Tool-call arguments that are not valid JSON never raise: they arrive as `arguments=None`.
- Credentials only via env; nothing on disk in the repo.
- Callers never see provider classes, only the chat model from `model_for` and its `Reply`.
- The fake tier is deterministic: same request in, same response out.

## How to test

`docker compose run --rm test /opt/venv/bin/pytest models -q`: tier selection, the local request/response mapping through `httpx.MockTransport` (no network), and every fake flow.
