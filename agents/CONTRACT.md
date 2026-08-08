# agents

Purpose: the ADK layer. Three agent kinds, all built here and nowhere else. Prompts live in `agents/prompts/*.md`, never inline in code.

## Agent kinds

- **Monument (root agent).** The figure at the village center. Routes and synthesizes; holds no corpus. Tools: `create_keeper`, `list_keepers`, and one AgentTool per existing keeper (call-and-return, so it can fan out to several keepers and combine answers). Creating a keeper through conversation and answering cross-memory questions both happen here.
- **Keeper agent.** One per keeper, built on demand from her profile. Persona from her doc; context carries today's date, her index rows and session summary; opens full books through a `read_book` tool only when the index points at them. On a tell she writes a book (grounded extraction of title, tags, entities, one liner). On an ask she answers only from books she actually opened.
- **Dream agents.** A per-keeper dream pass (reads her library, returns themes with cited slugs) and one synthesis agent (merges all passes into the knowledge graph, the dark keepers and the run narrative). Invoked only by the dreaming box.

## Public API

| method | in | out |
|---|---|---|
| `monument_chat(world, text)` | user message | `{reply, created_keeper?}` |
| `keeper_tell(world, keeper, text)` | user message | `{reply, book?}` (dark keepers reply in archetype voice, never write) |
| `keeper_ask(world, keeper, question)` | question | `{answer, sources: [slug], grounded, followup}` |
| `keeper_chatter(world, keeper)` | | one short ambient line |
| `dream_pass(world, keeper)` | | themes with cited slugs |
| `dream_synthesis(world, passes)` | all passes | `{graph, dark_keepers, dark_books, narrative}` |

## Errors (closed set)

`MODEL_ERROR` (after retries; callers fall back deterministically, the game never 500s on it).

## Invariants

- Grounding is validated outside the model: any cited slug not in the keeper's index is dropped; with nothing left, `grounded: false` and the answer becomes a follow-up question or an offer to save the memory. A memory is never invented.
- ADK session service keys sessions per `(world, keeper)`; the monument keys per `(world)`.
- Every model call goes through `models.model_for(role)`.
- Token usage per call is reported back to the caller so the engine can meter tiredness.
