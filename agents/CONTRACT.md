# agents

Purpose: the ADK layer. Every agent in the project is built here; prompts live in `src/mk_agents/prompts/*.md`, never inline in code. Every flow survives a broken model through deterministic fallbacks: the game never fails on a model error.

## Agent kinds

- **Monument (root agent).** The stone figure at the village center. Holds no corpus. Tools: `create_keeper`, `list_keepers`, plus one AgentTool per keeper (call-and-return), so one question can fan out to several shelves and come back as one synthesized answer.
- **Keeper agent.** Built on demand from her profile. Context carries today's date, her shortlisted index and session summary; she opens full books only through her `read_book` tool. Tell extracts book fields; ask answers only from books actually opened. Every flow (tell, ask, talk, the monument, the ridge) carries `resolve_date(phrase)` whenever the user's message holds a day given relative to today (`dates.PHRASE_RE`), bound to that message: a relative day the user wrote ("tomorrow", "in two weeks", "next friday", "3 days ago", "march 3") becomes the calendar date and weekday, and the prompts write that date, never the phrase; a phrase the user did not write is refused, so the model cannot wander through phrases of its own. When the api holds a lookups box, tell and ask also carry the lookup tools (`fetch_youtube_transcript`, `find_song_lyrics`, `find_movie_facts`, `find_movie_plot`, `find_song_facts`, `find_book_facts`, `find_podcast_transcript`; the lookups contract), each family offered only when the message names that kind of work (`LOOKUP_CUES`): capture requests ("save this song", "I just finished <book>") become enriched books, and books stay the single source of the user's memories.
- **Ridge keeper agent** (`dark_chat`). A dark keeper never routes: every message is a conversation grounded in the reading that made her (her dream books) and in any village book she opens through `read_book(keeper_id, slug)` across every light shelf (the books her reading cites are listed first). The `dark_keeper` prompt makes her sentient and therapeutic about her theme: reflect, connect two memories, ask one real question; nothing is written.
- **Runs are bounded and prompts name only the tools present.** `runtime.run_agent` caps one run at `MAX_LLM_CALLS` (12) model calls and stops the moment the model repeats an identical tool call. `runtime.run_flow(..., accept)` runs a flow with its tools and, when that pass does not end in an accepted answer (looped, capped, or wrote something else), runs the model once more without tools, carrying the lookups it made as text; only a second failure reaches the deterministic fallback. The date and lookup rules of every prompt are filled per message (`$date_rule`, `$lookup_rule`) from the tools actually offered, because a named but absent tool makes a model hallucinate the call.
- **Dream prose agents.** Single completions used by the dreaming box: `dream_write` (a dark keeper's name, persona and book from a theme) and `dream_narrative` (the night's summary).

## Public API

Class `AgentsApi(library, gateway, lookups=None)`; `lookups` is a `LookupsApi`-shaped object (see `lookups/CONTRACT.md`), and without it the lookup tools simply do not exist.

| method | in | out |
|---|---|---|
| `keeper_say(world, kid, text)` async | user message | routes the message with one model call (`say_route` prompt; wording fallback when the model fails: a question asks, a few words with no capture cue talk, the rest tells) and returns the tell, ask or talk result plus `kind: "tell"\|"ask"\|"talk"` |
| `keeper_talk(world, kid, text)` async | small talk | `{reply, book: null, book_grown: null}`; one or two sentences in her voice (`keeper_talk` prompt), nothing written, both turns recorded |
| `keeper_tell(world, kid, text)` async | user message | `{reply, book?, book_grown?}`; a follow-up naming an existing book grows it (`extends_slug` from the model, validated against her shelf, appended as a dated section) and returns `book_grown` instead of `book`; a passing remark (`note: true` from the model) lands as a dated entry in her one notes book (slug `notes`, `about_slugs` validated against her shelf and kept as its links) and returns it as `book_grown`; a model that does not answer leaves a reply saying so and the raw text as the body; the keeper authors the book's full body from the told memory (markdown, sized by the material; the raw text is the fallback body); dark keepers reply in archetype voice, never write; `LIBRARY_FULL` raises after the turns are still recorded |
| `keeper_ask(world, kid, question)` async | question | `{answer, sources, grounded, followup}`; the answer addresses the question from the opened books, it never pastes a book body back |
| `keeper_chatter(world, kid)` | | one bubble line (< 90 chars) from the lines the last consolidation drew from her books, time-bucketed rotation, no model, no writes; `None` while she has none (before the first dreaming, or an empty shelf) |
| `refresh_chatter(world)` | | stores every keeper's bubble lines, literally from her books (one liners and `Ask me about <title>.`; sleep and notes books stay silent); the dreaming box calls it at the end of each run; returns keeper id -> count |
| `dark_chat(world, kid, text)` async | user message | `{reply, book: null, book_grown: null, sources}`; the ridge conversation above; `keeper_say` sends every dark keeper here with `kind: "talk"` |
| `monument_chat(world, text)` async | user message | `{reply, created_keeper?}`; the monument holds no session, keepers hold the memory; monument turns are unmetered by design (she has no shelf of her own) |
| `dream_write(archetype, elements, evidence)` async | theme facts | `{name, persona, body_md, one_liner}` |
| `dream_narrative(theme_keys)` async | keys | one paragraph |

## Invariants

- Grounding in `keeper_ask` is validated outside the model: `used_slugs` are filtered to books the agent actually opened via `read_book`; nothing left means `grounded: false`. The model owns `followup`: an ungrounded answer with `followup: false` is a complete answer about the keeper herself, never an invented memory.
- Relative dates in questions resolve by rules (`dates.py`) and bias the shortlist; no model involved.
- Every tell/ask appends both turns to the keeper's session, harvests imperative constraint sentences verbatim, and meters reported token usage (estimate fallback).
- Every model call goes through `gateway.model_for(role)`; roles used: `chat`, `dream`.
- Lookup tools never raise (the lookups contract): a failed lookup leaves the flow exactly as if the tool was never called.
- Model failures log and fall back deterministically (dated citation, extraction fields, template prose); no exception ever escapes a flow because of a model.

## How to test

`docker compose run --rm test /opt/venv/bin/pytest agents -q`: the full contract through `AgentsApi` on the fake tier and the fake Firestore, real ADK runner and tools in the loop.
