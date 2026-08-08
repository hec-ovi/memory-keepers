# agents

Purpose: the ADK layer. Every agent in the project is built here; prompts live in `src/mk_agents/prompts/*.md`, never inline in code. Every flow survives a broken model through deterministic fallbacks: the game never fails on a model error.

## Agent kinds

- **Monument (root agent).** The stone figure at the village center. Holds no corpus. Tools: `create_keeper`, `list_keepers`, plus one AgentTool per keeper (call-and-return), so one question can fan out to several shelves and come back as one synthesized answer.
- **Keeper agent.** Built on demand from her profile. Context carries today's date, her shortlisted index and session summary; she opens full books only through her `read_book` tool. Tell extracts book fields; ask answers only from books actually opened.
- **Dream prose agents.** Single completions used by the dreaming box: `dream_write` (a dark keeper's name, persona and book from a theme) and `dream_narrative` (the night's summary).

## Public API

Class `AgentsApi(library, gateway)`.

| method | in | out |
|---|---|---|
| `keeper_tell(world, kid, text)` async | user message | `{reply, book?}`; dark keepers reply in archetype voice, never write; `LIBRARY_FULL` raises after the turns are still recorded |
| `keeper_ask(world, kid, question)` async | question | `{answer, sources, grounded, followup}` |
| `keeper_chatter(world, kid)` | | one bubble line (< 90 chars): deterministic per-keeper pools, time-bucketed rotation, no model, no writes |
| `monument_chat(world, text)` async | user message | `{reply, created_keeper?}`; the monument holds no session, keepers hold the memory |
| `dream_write(archetype, elements, evidence)` async | theme facts | `{name, persona, body_md, one_liner}` |
| `dream_narrative(theme_keys)` async | keys | one paragraph |

## Invariants

- Grounding is validated outside the model: `used_slugs` are filtered to books the agent actually opened via `read_book`; nothing left means `grounded: false` plus a follow-up. A memory is never invented.
- Relative dates in questions resolve by rules (`dates.py`) and bias the shortlist; no model involved.
- Every tell/ask appends both turns to the keeper's session, harvests imperative constraint sentences verbatim, and meters reported token usage (estimate fallback).
- Every model call goes through `gateway.model_for(role)`; roles used: `chat`, `dream`.
- Model failures log and fall back deterministically (dated citation, extraction fields, template prose); no exception ever escapes a flow because of a model.

## How to test

`docker compose run --rm test /opt/venv/bin/pytest agents -q`: the full contract through `AgentsApi` on the fake tier and the fake Firestore, real ADK runner and tools in the loop.
