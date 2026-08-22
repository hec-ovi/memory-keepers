"""The agents facade: everything the engine and the dreaming box call.
Every flow survives a broken model through deterministic fallbacks."""
import logging
import re
from datetime import date

from google.adk.tools.agent_tool import AgentTool
from mk_library import Library, LibraryError
from mk_library.records import Turn
from mk_library.store import now_iso
from mk_models import ModelGateway

from . import chatter, dates
from .fallbacks import (STOPWORDS, dated_citation, extract_book_fields,
                        harvest_constraints, parse_json, route_by_wording)
from .prompting import index_block, index_block_across, prompt, session_block
from .runtime import build_agent, run_agent, run_flow

log = logging.getLogger(__name__)
SHORTLIST = 6
# A lookup family is offered only when the message names that kind of work,
# so a model cannot wander the tools over companies, products or technologies.
LOOKUP_CUES = {
    "fetch_youtube_transcript": r"youtube\.com|youtu\.be",
    "find_song_lyrics": r"\blyrics?\b",
    "find_song_facts": r"\b(songs?|albums?|tracks?|singer|band|lyrics?)\b",
    "find_book_facts": r"\b(books?|novels?|author|reading|read|treatise)\b",
    "find_podcast_transcript": r"\b(podcasts?|episodes?)\b",
    "find_movie_facts": r"\b(movies?|films?|watched|director|cinema)\b",
    "find_movie_plot": r"\b(movies?|films?|watched|director|cinema)\b",
}
# Chars of each turn kept in the session: the log the dialog replays as chat
# history and sleep binds into books (which dreaming then links across). Full
# messages up to the cap; a told file's complete text lives in its book.
TURN_TEXT_CAP = 2000


def _today() -> str:
    return date.today().isoformat()


class AgentsApi:
    def __init__(self, library: Library, gateway: ModelGateway, lookups=None):
        self.library = library
        self.gateway = gateway
        self.lookups = lookups  # LookupsApi-shaped; optional, tools appear when present

    def _date_tool(self, text: str) -> list:
        """resolve_date, bound to the user's message: present only when the
        message holds a day given relative to today, and answering only for a
        phrase the user actually wrote, so a model cannot wander through
        phrases of its own (a month or a year alone is not a day to resolve)."""
        said = " ".join(text.lower().split())
        if not dates.PHRASE_RE.search(said):
            return []

        def resolve_date(phrase: str) -> dict:
            """Calendar date for a day the user gave relative to today, quoted
            exactly as written in their message. Only for such phrases; a date
            written with its month or year needs no call."""
            wording = " ".join(phrase.lower().split())
            if wording not in said:
                return {"ok": False, "phrase": phrase,
                        "error": "the user did not write that; resolve only a phrase "
                                 "from their message, or write the date as they gave it"}
            day = dates.resolve_phrase(wording, date.today())
            if day is None:
                return {"ok": False, "phrase": phrase,
                        "error": "not a day relative to today; write it as the user gave it"}
            return {"ok": True, "phrase": phrase, "date": day.isoformat(),
                    "weekday": day.strftime("%A"), "today": _today()}

        return [resolve_date]

    def _keeper_tools(self, text: str) -> list:
        """Every keeper flow carries the date tool; lookups when the box is wired."""
        return [*self._date_tool(text), *self._lookup_tools(text)]

    def _lookup_tools(self, text: str) -> list:
        if not self.lookups:
            return []
        lookups = self.lookups

        def fetch_youtube_transcript(url: str) -> dict:
            """Fetch the transcript of a YouTube video by its link or id."""
            return lookups.youtube_transcript(url)

        def find_song_lyrics(title: str, artist: str = "") -> dict:
            """Look up a song's lyrics by title and, when known, artist."""
            return lookups.song_lyrics(title, artist)

        def find_movie_facts(title: str, year: str = "") -> dict:
            """Look up a movie's year, director, cast and short plot by title."""
            return lookups.movie_facts(title, year)

        def find_movie_plot(title: str, year: str = "") -> dict:
            """Fetch a movie's full plot summary (Wikipedia, cite the url)."""
            return lookups.movie_plot(title, year)

        def find_song_facts(title: str, artist: str = "") -> dict:
            """Look up a song's year, artist and album (open data, storable)."""
            return lookups.song_facts(title, artist)

        def find_book_facts(title: str) -> dict:
            """Look up a book's author, subjects and, when public domain, its
            full-text link."""
            return lookups.book_facts(title)

        def find_podcast_transcript(show: str, episode: str = "") -> dict:
            """Fetch a podcast episode's transcript when the show publishes
            one; missing transcripts are a normal answer."""
            return lookups.podcast_transcript(show, episode)

        said = text.lower()
        return [tool for tool in (fetch_youtube_transcript, find_song_lyrics, find_movie_facts,
                                  find_movie_plot, find_song_facts, find_book_facts,
                                  find_podcast_transcript)
                if re.search(LOOKUP_CUES[tool.__name__], said)]

    def _read_any_book_tool(self, world: str, opened: list[str]):
        """The ridge reads across the village: any keeper's book by id and slug."""
        def read_book(keeper_id: str, slug: str) -> dict:
            """Open one book from any keeper's shelf by keeper id and slug, and read it."""
            try:
                book = self.library.get_book(world, keeper_id, slug)
            except LibraryError:
                return {"error": "no such book"}
            opened.append(f"{keeper_id}/{slug}")
            return {"keeper_id": keeper_id, "slug": slug, "title": book.title,
                    "date": book.date, "body_md": book.body_md}
        return read_book

    def _read_book_tool(self, world: str, kid: str, allowed: set[str] | None = None,
                        opened: list[str] | None = None):
        """One read_book closure for every ask flow; allowed=None opens any shelf slug."""

        def read_book(slug: str) -> dict:
            """Open one book from the shelf by its slug and read it."""
            if allowed is not None and slug not in allowed:
                return {"error": "not on this shelf"}
            try:
                book = self.library.get_book(world, kid, slug)
            except LibraryError:
                return {"error": "not on this shelf"}
            if opened is not None:
                opened.append(slug)
            return book.payload()

        return read_book

    # -- keeper chat --------------------------------------------------------
    async def keeper_say(self, world: str, kid: str, text: str) -> dict:
        """One door for every flow: the model reads the message and routes it
        to tell (keep a memory), ask (answer from the shelves) or talk. A dark
        keeper always converses (dark_chat); she never writes."""
        if self.library.get_keeper(world, kid).side == "dark":
            return await self.dark_chat(world, kid, text) | {"kind": "talk"}
        kind = await self._route_say(text)
        if kind == "ask":
            out = await self.keeper_ask(world, kid, text)
        elif kind == "talk":
            out = await self.keeper_talk(world, kid, text)
        else:
            out = await self.keeper_tell(world, kid, text)
        return out | {"kind": kind}

    async def _route_say(self, text: str) -> str:
        try:
            raw, _ = await run_agent(
                build_agent("say_route", self.gateway.model_for("chat"),
                            prompt("say_route"), []),
                text)
            kind = (parse_json(raw) or {}).get("kind")
            if kind in ("tell", "ask", "talk"):
                return kind
        except Exception:
            log.exception("say router failed, falling back to wording")
        return route_by_wording(text)

    async def keeper_talk(self, world: str, kid: str, text: str) -> dict:
        """Small talk: she answers in her voice, nothing is written; the turn
        still lands in her session."""
        keeper = self.library.get_keeper(world, kid)
        session = self.library.session_read(world, kid)
        rows = self.library.index_rows(world, kid)
        instruction = prompt("keeper_talk", persona=keeper.persona, topic=keeper.topic,
                             today=_today(), session=session_block(session),
                             index=index_block(rows[:SHORTLIST]))
        reply, tokens = "", 0
        try:
            raw, tokens = await run_flow("keeper_talk", self.gateway.model_for("chat"),
                                         instruction, self._date_tool(text), text)
            reply = str((parse_json(raw) or {}).get("reply") or "").strip()
        except Exception:
            log.exception("talk model failed, using fallback")
        reply = reply or "I am listening. Tell me something to keep, or ask me about the shelf."
        self._record(world, kid, text, reply, tokens)
        return {"reply": reply, "book": None, "book_grown": None}

    async def keeper_tell(self, world: str, kid: str, text: str) -> dict:
        keeper = self.library.get_keeper(world, kid)
        session = self.library.session_read(world, kid)
        rows = self.library.index_rows(world, kid)
        instruction = prompt("keeper_tell", persona=keeper.persona, topic=keeper.topic,
                             today=_today(), session=session_block(session),
                             index=index_block(rows[:SHORTLIST * 2]))
        reply_data, tokens = {}, 0
        try:
            raw, tokens = await run_flow("keeper_tell", self.gateway.model_for("chat"),
                                         instruction, self._keeper_tools(text), text)
            reply_data = parse_json(raw) or {}
        except Exception:
            log.exception("tell model failed, using fallbacks")
        fields = extract_book_fields(text)
        for key in fields:
            value = reply_data.get(key)
            if value:
                fields[key] = value
        reply = reply_data.get("reply") or (
            f"I could not reach my words just now, so I kept yours as they are: "
            f"{fields['title']}.")
        body = reply_data.get("body_md")  # the keeper authors the book
        body = body.strip() if isinstance(body, str) and body.strip() else text

        book = None
        grown = None
        error = None
        shelved = {r["slug"] for r in rows}
        extends = reply_data.get("extends_slug")
        about = [s for s in (reply_data.get("about_slugs") or [])
                 if isinstance(s, str) and s in shelved]
        if keeper.side == "light":  # dark keepers answer in archetype voice, never write
            try:
                if isinstance(extends, str) and extends in shelved:
                    # A follow-up grows the existing book instead of minting a new one.
                    grown = self.library.append_to_book(world, kid, extends,
                                                        note_md=body, date=_today())
                elif reply_data.get("note") is True:
                    # A passing remark lands in her one notes book, pointing at
                    # the books it is about.
                    grown = self.library.append_note(world, kid, note_md=body, date=_today(),
                                                     tags=fields["tags"], about=about)
                else:
                    book = self.library.write_book(
                        world, kid, title=fields["title"], body_md=body, date=_today(),
                        source="told", one_liner=fields["one_liner"],
                        tags=fields["tags"], entities=fields["entities"])
            except LibraryError as e:
                error = e
                reply = "My bookcase is full. Let me sleep to bind old books together."
        self._record(world, kid, text, reply, tokens)
        if error:
            raise error
        return {"reply": reply, "book": book.summary() if book else None,
                "book_grown": grown.summary() if grown else None}

    async def keeper_ask(self, world: str, kid: str, question: str) -> dict:
        keeper = self.library.get_keeper(world, kid)
        session = self.library.session_read(world, kid)
        rows = self.library.index_rows(world, kid)
        resolved = dates.resolve(question, date.today())
        shortlist = self._shortlist(rows, question, resolved)
        opened: list[str] = []
        read_book = self._read_book_tool(world, kid,
                                         allowed={r["slug"] for r in shortlist},
                                         opened=opened)
        date_note = (f"\nThe question points at {resolved[2]} "
                     f"({resolved[0]} to {resolved[1]}).\n") if resolved else ""
        instruction = prompt("keeper_ask", persona=keeper.persona, topic=keeper.topic,
                             today=_today(), index=index_block(shortlist),
                             date_note=date_note, session=session_block(session))
        data, tokens = None, 0
        try:
            raw, tokens = await run_flow("keeper_ask", self.gateway.model_for("chat"), instruction,
                                         [read_book, *self._keeper_tools(question)], question)
            data = parse_json(raw)
        except Exception:
            log.exception("ask model failed, using fallbacks")

        used, grounded, answer, followup = [], False, "", True
        if data and isinstance(data.get("used_slugs"), list):
            used = [s for s in data["used_slugs"] if s in set(opened)]
            grounded = bool(used)
            answer = str(data.get("answer") or "").strip()
            # The model owns needs_followup: an ungrounded answer can still be
            # complete (a question about her, not about a memory).
            followup = bool(data.get("needs_followup"))
        if not answer:
            if shortlist:
                used, grounded, followup = [shortlist[0]["slug"]], True, False
                answer = dated_citation(shortlist[0])
            else:
                used, grounded, followup = [], False, True
                answer = ("I have nothing on my shelves about that yet. "
                          "Want me to keep it as a new memory?")
        sources = [r for s in used for r in rows if r["slug"] == s]
        self._record(world, kid, question, answer, tokens)
        return {"answer": answer, "sources": sources,
                "grounded": grounded, "followup": followup}

    def keeper_chatter(self, world: str, kid: str) -> str | None:
        """One bubble line from the lines the last consolidation drew from her
        books; None while she has none (before the first dreaming, or an
        empty shelf)."""
        keeper = self.library.get_keeper(world, kid)
        return chatter.pick(keeper.chatter or [], keeper.id)

    def refresh_chatter(self, world: str) -> dict:
        """After a consolidation: every keeper's bubble lines, literally from
        her books (one liners and titles). Returns keeper id -> line count."""
        counts = {}
        for keeper in self.library.list_keepers(world):
            lines = chatter.lines_from_books(self.library.list_books(world, keeper.id))
            self.library.update_keeper(world, keeper.id, chatter=lines)
            counts[keeper.id] = len(lines)
        return counts

    async def dark_chat(self, world: str, kid: str, text: str) -> dict:
        """A keeper of the ridge talks: sentient about the theme she was born
        from, she may open any village book for context, reflects and asks.
        Nothing is written; both turns land in her session."""
        keeper = self.library.get_keeper(world, kid)
        session = self.library.session_read(world, kid)
        own = self.library.list_books(world, kid)
        reading = "\n\n".join(f"## {b.title}\n{b.body_md}" for b in own) or "(no reading yet)"
        cited = {link for b in own for link in b.links}
        rows = [r | {"keeper_id": k.id}
                for k in self.library.list_keepers(world) if k.side == "light"
                for r in self.library.index_rows(world, k.id)]
        first = [r for r in rows if f"{r['keeper_id']}/{r['slug']}" in cited]
        rest = [r for r in rows if f"{r['keeper_id']}/{r['slug']}" not in cited]
        shortlist = first + (self._shortlist(rest, text, None) if rest else [])
        opened: list[str] = []
        read_book = self._read_any_book_tool(world, opened)
        instruction = prompt("dark_keeper", persona=keeper.persona, keeper_name=keeper.name,
                             element=keeper.topic, archetype=keeper.archetype or "unnamed",
                             today=_today(), reading=reading,
                             index=index_block_across(shortlist[:SHORTLIST * 2]),
                             session=session_block(session))
        data, tokens = {}, 0
        try:
            raw, tokens = await run_flow("dark_keeper", self.gateway.model_for("chat"), instruction,
                                         [read_book, *self._date_tool(text)], text)
            data = parse_json(raw) or {}
        except Exception:
            log.exception("dark keeper model failed, using fallback")
        reply = str(data.get("reply") or "").strip() or (
            f"I was born from what kept returning: {keeper.topic}. "
            "Where does it touch you these days?")
        used = [s for s in (data.get("used_slugs") or []) if s in set(opened)]
        self._record(world, kid, text, reply, tokens)
        return {"reply": reply, "book": None, "book_grown": None, "sources": used}

    # -- monument -------------------------------------------------------------
    async def monument_chat(self, world: str, text: str) -> dict:
        keepers = self.library.list_keepers(world)
        created: list = []

        def create_keeper(topic: str) -> dict:
            """Create a new keeper for a topic; she gets the next free house."""
            try:
                keeper = self.library.create_keeper(world, topic)
                created.append(keeper)
                return {"topic": keeper.topic, "id": keeper.id, "name": keeper.name}
            except LibraryError as e:
                return {"error": e.code}

        def list_keepers() -> dict:
            """List every keeper alive on the island."""
            return {"keepers": [f"{k.name} ({k.topic}, {k.side})" for k in keepers]}

        tools: list = [create_keeper, list_keepers, *self._date_tool(text)]
        for keeper in keepers:
            tools.append(AgentTool(agent=self._ask_subagent(world, keeper)))

        keeper_lines = "\n".join(
            f"- {k.name}: topic {k.topic}, {k.side} side, {k.book_count} books"
            for k in keepers) or "- none yet"
        instruction = prompt("monument", today=_today(), keeper_lines=keeper_lines)
        try:
            reply, _ = await run_agent(
                build_agent("monument", self.gateway.model_for("chat"), instruction, tools),
                text)
        except Exception:
            log.exception("monument model failed, using fallback")
            reply = ""
        if not reply.strip():
            reply = ("Done. " + created[0].name + " has her house now.") if created else \
                "I watch over the island. Ask me to create a keeper, or what your memories share."
        payload = created[0].payload() if created else None
        return {"reply": reply.strip(), "created_keeper": payload}

    def _ask_subagent(self, world: str, keeper):
        rows = self.library.index_rows(world, keeper.id)
        read_book = self._read_book_tool(world, keeper.id)
        instruction = prompt("keeper_ask", persona=keeper.persona, topic=keeper.topic,
                             today=_today(), index=index_block(rows[:SHORTLIST]),
                             date_note="", session="(asked by the monument)")
        return build_agent(f"ask_{keeper.id.replace('-', '_')}",
                           self.gateway.model_for("chat"), instruction, [read_book])

    # -- dreaming prose ------------------------------------------------------
    async def dream_write(self, archetype: str, elements: list[str],
                          evidence: list[str]) -> dict:
        message = "\n".join([*(f"element: {e}" for e in elements),
                             *(f"evidence: {v}" for v in evidence)])
        fallback = {
            "name": f"The one who circles {elements[0]}",
            "persona": "Born at night from what keeps returning. Speaks in "
                       "half-finished sentences and knows the shelves by heart.",
            "body_md": "While the island slept, the same shape surfaced across "
                       f"shelves: {', '.join(elements)}. It waits to be looked at.",
            "one_liner": f"A night reading about {elements[0]}.",
        }
        try:
            raw, _ = await run_agent(
                build_agent("dream_write", self.gateway.model_for("dream"),
                            prompt("dream_write", archetype=archetype), []), message)
            data = parse_json(raw) or {}
        except Exception:
            log.exception("dream_write model failed, using fallback")
            data = {}
        return {k: str(data.get(k) or fallback[k]) for k in fallback}

    async def dream_narrative(self, theme_keys: list[str]) -> str:
        message = "\n".join(f"theme: {k}" for k in theme_keys) or "no themes"
        try:
            raw, _ = await run_agent(
                build_agent("dream_narrative", self.gateway.model_for("dream"),
                            prompt("dream_narrative"), []), message)
            data = parse_json(raw) or {}
            if data.get("narrative"):
                return str(data["narrative"])
        except Exception:
            log.exception("dream_narrative model failed, using fallback")
        if theme_keys:
            return f"The island dreamed. {len(theme_keys)} thread(s) surfaced: " \
                   f"{', '.join(theme_keys)}."
        return "The island slept quietly; the shelves rest."

    # -- shared ---------------------------------------------------------------
    def _shortlist(self, rows, question, resolved):
        q_words = {w for w in re.findall(r"[a-z0-9]{3,}", question.lower())
                   if w not in STOPWORDS}
        scored = []
        for row in rows:
            hay = " ".join([row["title"], row["one_liner"],
                            " ".join(row["tags"]), " ".join(row["entities"])]).lower()
            score = sum(1 for w in q_words if w in hay)
            score += 2 * sum(1 for e in row["entities"] if e.lower() in question.lower())
            if resolved and resolved[0] <= row["date"] <= resolved[1]:
                score += 4
            scored.append((score, row))
        scored.sort(key=lambda p: (-p[0], p[1]["slug"]))
        return [row for score, row in scored[:SHORTLIST] if score > 0] or \
               [row for _, row in scored[:SHORTLIST]]

    def _record(self, world, kid, user_text, keeper_text, tokens):
        t = now_iso()
        self.library.session_append(
            world, kid,
            [Turn(t=t, role="user", text=user_text.strip()[:TURN_TEXT_CAP]),
             Turn(t=t, role="keeper", text=keeper_text.strip()[:TURN_TEXT_CAP])],
            constraints=harvest_constraints(user_text))
        estimate = tokens or (len(user_text) + len(keeper_text)) // 4
        self.library.meter_add(world, kid, estimate)
