"""The agents facade: everything the engine and the dreaming box call.
Every flow survives a broken model through deterministic fallbacks."""
import logging
import re
from datetime import date, datetime, timezone

from google.adk.tools.agent_tool import AgentTool
from mk_library import Library, LibraryError
from mk_library.records import Turn
from mk_models import ModelGateway

from . import chatter, dates
from .fallbacks import (STOPWORDS, dated_citation, extract_book_fields,
                        first_sentence, harvest_constraints, parse_json)
from .prompting import index_block, prompt, session_block
from .runtime import build_agent, run_agent

log = logging.getLogger(__name__)
SHORTLIST = 6


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _today() -> str:
    return date.today().isoformat()


class AgentsApi:
    def __init__(self, library: Library, gateway: ModelGateway):
        self.library = library
        self.gateway = gateway

    # -- keeper chat --------------------------------------------------------
    async def keeper_tell(self, world: str, kid: str, text: str) -> dict:
        keeper = self.library.get_keeper(world, kid)
        session = self.library.session_read(world, kid)
        instruction = prompt("keeper_tell", persona=keeper.persona, topic=keeper.topic,
                             today=_today(), session=session_block(session))
        reply_data, tokens = {}, 0
        try:
            raw, tokens = await run_agent(
                build_agent("keeper_tell", self.gateway.model_for("chat"), instruction, []),
                text)
            reply_data = parse_json(raw) or {}
        except Exception:
            log.exception("tell model failed, using fallbacks")
        fields = extract_book_fields(text)
        for key in fields:
            value = reply_data.get(key)
            if value:
                fields[key] = value
        reply = reply_data.get("reply") or f"It is on the shelf now: {fields['title']}."
        body = reply_data.get("body_md")  # the keeper authors the book
        body = body.strip() if isinstance(body, str) and body.strip() else text

        book = None
        error = None
        if keeper.side == "light":
            try:
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
        return {"reply": reply, "book": book.summary() if book else None}

    async def keeper_ask(self, world: str, kid: str, question: str) -> dict:
        keeper = self.library.get_keeper(world, kid)
        session = self.library.session_read(world, kid)
        rows = self.library.index_rows(world, kid)
        resolved = dates.resolve(question, date.today())
        shortlist = self._shortlist(rows, question, resolved)
        allowed = {r["slug"] for r in shortlist}
        opened: list[str] = []

        def read_book(slug: str) -> dict:
            """Open one book from the shelf by its slug and read it."""
            if slug not in allowed:
                return {"error": "not on this shelf"}
            book = self.library.get_book(world, kid, slug)
            opened.append(slug)
            return book.payload()

        date_note = (f"\nThe question points at {resolved[2]} "
                     f"({resolved[0]} to {resolved[1]}).\n") if resolved else ""
        instruction = prompt("keeper_ask", persona=keeper.persona, topic=keeper.topic,
                             today=_today(), index=index_block(shortlist),
                             date_note=date_note, session=session_block(session))
        data, tokens = None, 0
        try:
            raw, tokens = await run_agent(
                build_agent("keeper_ask", self.gateway.model_for("chat"),
                            instruction, [read_book]), question)
            data = parse_json(raw)
        except Exception:
            log.exception("ask model failed, using fallbacks")

        used, grounded, answer, followup = [], False, "", True
        if data and isinstance(data.get("used_slugs"), list):
            used = [s for s in data["used_slugs"] if s in set(opened)]
            grounded = bool(used)
            answer = str(data.get("answer") or "").strip()
            followup = bool(data.get("needs_followup")) or not grounded
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

    def keeper_chatter(self, world: str, kid: str) -> str:
        keeper = self.library.get_keeper(world, kid)
        return chatter.line_for(keeper.id, keeper.topic, keeper.side, keeper.archetype)

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

        tools: list = [create_keeper, list_keepers]
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
        payload = created[0].payload(budget=1) if created else None
        if payload:
            payload.pop("session", None)
        return {"reply": reply.strip(), "created_keeper": payload}

    def _ask_subagent(self, world: str, keeper):
        rows = self.library.index_rows(world, keeper.id)

        def read_book(slug: str) -> dict:
            """Open one book from this keeper's shelf by its slug."""
            try:
                return self.library.get_book(world, keeper.id, slug).payload()
            except LibraryError:
                return {"error": "not on this shelf"}

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
        t = _now_iso()
        self.library.session_append(
            world, kid,
            [Turn(t=t, role="user", text=first_sentence(user_text, 200)),
             Turn(t=t, role="keeper", text=first_sentence(keeper_text, 200))],
            constraints=harvest_constraints(user_text))
        estimate = tokens or (len(user_text) + len(keeper_text)) // 4
        self.library.meter_add(world, kid, estimate)
