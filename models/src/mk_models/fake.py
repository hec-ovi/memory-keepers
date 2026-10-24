"""Deterministic model behind the fake tier: same request in, same response out.

It recognizes the project's flows through the marker every prompt carries
(`<!-- flow:name -->`), emits valid JSON and real tool calls, so the whole
agent loop (tools included) runs offline in tests and dev with zero cost.
"""
import json
import re
from collections.abc import Sequence

from .reply import Reply, ToolCall

# Keep identical to mk_agents.fallbacks.STOPWORDS (models cannot import from agents).
STOPWORDS = {"the", "and", "that", "with", "about", "this", "from", "have", "what",
             "when", "where", "there", "were", "will", "your", "into", "just", "like"}
# Keep identical to mk_agents.fallbacks.ASK_OPENERS (models cannot import
# from agents); the fake router must match the real fallback.
ASK_OPENERS = frozenset(
    "what when where who whom whose why how which did do does can could "
    "would should is are was were am will have has had remind tell show".split())
# Keep identical to mk_agents.fallbacks.CAPTURE_CUES.
CAPTURE_CUES = frozenset("save keep remember note shelve".split())
REMARK_CUES = ("i liked", "i like", "i love", "i hate", "i did not like", "i didn't like",
               "i don't like", "not my", "loved", "hated")
SLUG_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}-[a-z0-9-]+\b")
RELATIVE_DAY_RE = re.compile(
    r"\b(day after tomorrow|tomorrow|yesterday|in (?:\w+) (?:days?|weeks?|months?)|"
    r"\w+ (?:days?|weeks?) ago|(?:next|this) (?:monday|tuesday|wednesday|thursday|"
    r"friday|saturday|sunday|week|month))\b")
ACROSS_ROW_RE = re.compile(r"^([a-z0-9-]+)/(\S+) \| ", re.M)
ENTITY_RE = re.compile(r"\b([A-Z][a-z]+(?: [A-Z][a-z]+)+)\b")
QUOTED_RE = re.compile(r'"([^"]{2,80})"')


def _first_sentence(text: str, cap: int) -> str:
    sentence = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0].strip().rstrip(".!?")
    return sentence[:cap].strip()


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]{4,}", text.lower()) if w not in STOPWORDS}


def _json(payload: dict) -> str:
    return json.dumps(payload)


def _payload(content: str) -> dict:
    """A tool message's content as a dict; plain text lands under `result`."""
    try:
        value = json.loads(content)
    except (TypeError, ValueError):
        value = None
    return value if isinstance(value, dict) else {"result": content}


class Request:
    """The parts of one chat request the flows read."""

    def __init__(self, messages: list[dict], tools: Sequence[dict]):
        self.system = next((m["content"] for m in messages if m["role"] == "system"), "")
        self.user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        names = {call["id"]: call["function"]["name"] for m in messages
                 if m["role"] == "assistant" for call in m.get("tool_calls") or []}
        # (tool name, result payload) for every tool message, oldest first
        self.results = [(names.get(m["tool_call_id"], ""), _payload(m["content"]))
                        for m in messages if m["role"] == "tool"]
        self.tools = [t["function"]["name"] for t in tools]


class FakeModel:
    """A flow handler answers with text (str) or one tool call ((name, args))."""

    async def complete(self, messages: list[dict], tools: Sequence[dict] = ()) -> Reply:
        req = Request(messages, tools)
        flow_match = re.search(r"<!-- flow:([a-z_]+) -->", req.system)
        flow = flow_match.group(1) if flow_match else "plain"
        out = getattr(self, f"_{flow}", self._plain)(req)
        prompt_chars = sum(len(str(m.get("content") or "")) for m in messages)
        if isinstance(out, str):
            return Reply(text=out, tokens=(prompt_chars + len(out)) // 4)
        name, args = out
        call = ToolCall(id=f"call_{len(messages)}", name=name, arguments=args)
        return Reply(text="", tool_calls=(call,), tokens=(prompt_chars + 160) // 4)

    # -- flows ----------------------------------------------------------------
    @staticmethod
    def _lookup_call(req: Request, text: str) -> tuple[str, dict] | None:
        """Deterministic tool dispatch for keeper flows: a relative day, a
        song, a podcast, a book or a movie in the told text triggers the
        matching wired tool."""
        lower = text.lower()
        day = RELATIVE_DAY_RE.search(lower)
        if day and "resolve_date" in req.tools:
            return "resolve_date", {"phrase": day.group(1)}
        quoted = QUOTED_RE.search(text)
        title = quoted.group(1) if quoted else _first_sentence(text, 40)
        if "lyrics" in lower and "find_song_lyrics" in req.tools:
            return "find_song_lyrics", {"title": title}
        if "song" in lower and "find_song_facts" in req.tools:
            return "find_song_facts", {"title": title}
        if "podcast" in lower and "find_podcast_transcript" in req.tools:
            return "find_podcast_transcript", {"show": title}
        if ("book" in lower or "finished" in lower) and "find_book_facts" in req.tools:
            return "find_book_facts", {"title": title}
        if ("movie" in lower or "film" in lower) and "find_movie_facts" in req.tools:
            return "find_movie_facts", {"title": title}
        return None

    @staticmethod
    def _lookup_note(req: Request) -> str:
        for _, payload in req.results:
            if not payload.get("ok"):
                continue
            detail = payload.get("text") or payload.get("lyrics") or ", ".join(
                str(payload[k]) for k in ("title", "artist", "album", "author",
                                          "year", "director", "show", "episode",
                                          "plot", "date", "weekday")
                if payload.get(k))
            if detail:
                return f"\n\nFrom the lookup, kept in the margin: {detail[:400]}"
        return ""

    def _say_route(self, req: Request) -> str:
        # Mirrors mk_agents.fallbacks.route_by_wording.
        t = req.user.strip().lower()
        words = re.findall(r"[a-z']+", t)
        if t.endswith("?") or "?" in t.split("\n", 1)[0] or (words and words[0] in ASK_OPENERS):
            kind = "ask"
        elif len(words) <= 3 and not CAPTURE_CUES & set(words):
            kind = "talk"
        else:
            kind = "tell"
        return _json({"kind": kind})

    def _dark_keeper(self, req: Request):
        """Opens the first listed village book, then reflects and asks."""
        row = ACROSS_ROW_RE.search(req.system)
        if not req.results and row and "read_book" in req.tools:
            return "read_book", {"keeper_id": row.group(1), "slug": row.group(2)}
        opened = [f"{p['keeper_id']}/{p['slug']}" for _, p in req.results if p.get("slug")]
        element = re.search(r'because "([^"]+)" kept returning', req.system)
        head = element.group(1) if element else "what returns"
        return _json({"reply": f"{head} keeps coming back through your shelves. "
                               "Where does it touch you most these days?",
                      "used_slugs": opened})

    def _keeper_talk(self, req: Request) -> str:
        return _json({"reply": "I hear you. Tell me something to keep, or ask me about the shelf."})

    def _keeper_tell(self, req: Request):
        text = req.user
        if not req.results:
            call = self._lookup_call(req, text)
            if call is not None:
                return call
        extends = self._extends_slug(text, req.system)
        title = _first_sentence(text, 60) or "A new memory"
        tags = sorted(_words(text))[:3]
        entities = list(dict.fromkeys(ENTITY_RE.findall(text)))[:4]
        if extends:
            return _json({
                "reply": "I have added it to the book.",
                "title": title, "tags": tags, "entities": entities,
                "one_liner": _first_sentence(text, 140) + ".",
                "body_md": text, "extends_slug": extends,
            })
        if self._is_remark(text):
            about = self._best_slug(text, req.system)
            return _json({
                "reply": "Noted on the loose pages.",
                "title": title, "tags": tags, "entities": entities,
                "one_liner": _first_sentence(text, 140) + ".",
                "body_md": text, "extends_slug": None,
                "note": True, "about_slugs": [about] if about else [],
            })
        names = ", ".join(entities) if entities else "no one by name"
        body = "\n\n".join([
            f"# {title}", text,
            f"The shelf keeps the day with it. This one names {names}, and it "
            f"was told plainly, the way memories arrive before they settle. "
            f"What it carries sits beside the older books now, close enough "
            f"to touch spines.",
            f"Margin note: bound the evening it was told, filed under "
            f"{', '.join(tags) if tags else 'no tags yet'}. The pages run past the "
            f"small tier on purpose: a told memory is a book, and a book has a body.",
        ])
        body += self._lookup_note(req)
        return _json({
            "reply": f"It is on the shelf now: {title}.",
            "title": title, "tags": tags, "entities": entities,
            "one_liner": _first_sentence(text, 140) + ".",
            "body_md": body,
        })

    @staticmethod
    def _best_slug(text: str, system: str) -> str | None:
        """The shelved slug sharing the most words with the text, if any."""
        slugs = list(dict.fromkeys(SLUG_RE.findall(system)))
        scored = sorted(((len(_words(text) & _words(s.replace("-", " "))), s)
                         for s in slugs), key=lambda p: (-p[0], p[1]))
        return scored[0][1] if scored and scored[0][0] > 0 else None

    def _extends_slug(self, text: str, system: str) -> str | None:
        """A follow-up cue plus word overlap with a shelved slug = extension."""
        if not text.lower().startswith(("also", "and ", "yes", "one more")):
            return None
        return self._best_slug(text, system)

    @staticmethod
    def _is_remark(text: str) -> bool:
        """A short opinion or reaction = a note, not a book."""
        lower = text.strip().lower()
        return len(lower.split()) <= 12 and lower.startswith(REMARK_CUES)

    def _keeper_ask(self, req: Request):
        if req.results:
            books = [p for _, p in req.results]
            slugs = [b["slug"] for b in books if b.get("slug")]
            first = books[0]
            answer = f"On {first.get('date', 'that day')} you told me: " \
                     f"{_first_sentence(first.get('body_md', ''), 140)}."
            return _json({"answer": answer, "used_slugs": slugs, "needs_followup": False})
        question_words = _words(req.user)
        asked_dates = re.findall(r"\d{4}-\d{2}-\d{2}", req.user)
        slugs = list(dict.fromkeys(SLUG_RE.findall(req.system)))
        scored = sorted(((len(question_words & _words(s.replace('-', ' ')))
                          + (10 if any(s.startswith(d) for d in asked_dates) else 0), s)
                         for s in slugs), key=lambda p: (-p[0], p[1]))
        if scored and scored[0][0] > 0:
            return "read_book", {"slug": scored[0][1]}
        return _json({"answer": "I have nothing on my shelves about that yet. "
                                "Want me to keep it as a new memory?",
                      "used_slugs": [], "needs_followup": True})

    def _monument(self, req: Request):
        if req.results:
            name, body = req.results[-1]
            if name == "create_keeper":
                return f"Done. The keeper of {body.get('topic', 'it')} has her house now."
            return f"Here is what came back: {json.dumps(body)}"
        text = req.user
        wanted = re.search(r"keeper (?:for|of|about) ([a-zA-Z ]{3,40})", text)
        if wanted and re.search(r"\b(create|new|make|want)\b", text.lower()):
            return "create_keeper", {"topic": wanted.group(1).strip()}
        for tool_name in req.tools:
            shelf = tool_name.removeprefix("ask_").replace("_", " ")
            if tool_name.startswith("ask_") and shelf in text.lower():
                return tool_name, {"request": text}
        return "I watch over the whole island. Ask me to create a keeper, " \
               "or ask what your memories share."

    def _dream_write(self, req: Request) -> str:
        elements = re.findall(r"element: ([^\n]+)", req.user) or ["something unnamed"]
        head = elements[0]
        return _json({
            "name": f"The one who circles {head}",
            "persona": f"Born at night from everything that keeps returning to {head}. "
                       "Speaks in half-finished sentences.",
            "body_md": "While the island slept, the same shape surfaced in different "
                       f"shelves: {', '.join(elements)}. It is not a coincidence. It "
                       "waits to be looked at directly.",
            "one_liner": f"A night reading about {head}.",
        })

    def _dream_select(self, req: Request) -> str:
        return _json({"human": re.findall(r"^key: (\S+)", req.user, re.M), "technical": []})

    def _dream_narrative(self, req: Request) -> str:
        themes = re.findall(r"theme: ([^\n]+)", req.user)
        if themes:
            return _json({"narrative": "The island dreamed. "
                          f"{len(themes)} thread(s) surfaced: {', '.join(themes)}."})
        return _json({"narrative": "The island dreamed quietly; nothing new "
                                   "surfaced, and the shelves rest."})

    def _plain(self, req: Request) -> str:
        return f"heard: {_first_sentence(req.user, 80)}"
