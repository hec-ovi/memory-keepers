"""Deterministic model behind the fake tier: same request in, same response out.

It recognizes the project's flows through the marker every prompt carries
(`<!-- flow:name -->`), emits valid JSON and real function calls, so the whole
agent loop (tools included) runs offline in tests and dev with zero cost.
"""
import json
import re
from typing import AsyncGenerator

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

# Keep identical to mk_agents.fallbacks.STOPWORDS (models cannot import from agents).
STOPWORDS = {"the", "and", "that", "with", "about", "this", "from", "have", "what",
             "when", "where", "there", "were", "will", "your", "into", "just", "like"}
SLUG_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}-[a-z0-9-]+\b")
ENTITY_RE = re.compile(r"\b([A-Z][a-z]+(?: [A-Z][a-z]+)+)\b")
YOUTUBE_RE = re.compile(r"https?://\S*(?:youtube\.com|youtu\.be)/\S+")
QUOTED_RE = re.compile(r'"([^"]{2,80})"')


def _first_sentence(text: str, cap: int) -> str:
    sentence = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0].strip().rstrip(".!?")
    return sentence[:cap].strip()


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]{4,}", text.lower()) if w not in STOPWORDS}


class FakeLlm(BaseLlm):
    model: str = "fake-1"

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        system = self._system_text(llm_request)
        flow_match = re.search(r"<!-- flow:([a-z_]+) -->", system)
        flow = flow_match.group(1) if flow_match else "plain"
        handler = getattr(self, f"_{flow}", self._plain)
        content = handler(llm_request, system)
        prompt_tokens = (len(system) + sum(len(p.text or "")
                         for c in llm_request.contents for p in c.parts or [])) // 4
        out_tokens = sum(len(p.text or "") + (40 if p.function_call else 0)
                         for p in content.parts) // 4
        yield LlmResponse(
            content=content,
            usage_metadata=types.GenerateContentResponseUsageMetadata(
                prompt_token_count=prompt_tokens, candidates_token_count=out_tokens,
                total_token_count=prompt_tokens + out_tokens),
        )

    # -- request reading ----------------------------------------------------
    @staticmethod
    def _system_text(req: LlmRequest) -> str:
        si = req.config.system_instruction
        if si is None:
            return ""
        if isinstance(si, str):
            return si
        parts = getattr(si, "parts", None) or []
        return "\n".join(p.text or "" for p in parts)

    @staticmethod
    def _last_user_text(req: LlmRequest) -> str:
        for content in reversed(req.contents):
            if content.role == "user":
                texts = [p.text for p in content.parts or [] if p.text]
                if texts:
                    return "\n".join(texts)
        return ""

    @staticmethod
    def _function_responses(req: LlmRequest) -> list:
        found = []
        for content in req.contents:
            for part in content.parts or []:
                if part.function_response is not None:
                    found.append(part.function_response)
        return found

    @staticmethod
    def _text(payload) -> types.Content:
        text = payload if isinstance(payload, str) else json.dumps(payload)
        return types.Content(role="model", parts=[types.Part(text=text)])

    @staticmethod
    def _call(name: str, args: dict) -> types.Content:
        return types.Content(role="model", parts=[
            types.Part(function_call=types.FunctionCall(name=name, args=args))])

    # -- flows ----------------------------------------------------------------
    def _lookup_call(self, req, text: str) -> types.Content | None:
        """Deterministic lookup-tool dispatch for keeper flows: a YouTube link,
        a song, or a movie in the told text triggers the matching wired tool."""
        tools = req.tools_dict or {}
        lower = text.lower()
        url = YOUTUBE_RE.search(text)
        if url and "fetch_youtube_transcript" in tools:
            return self._call("fetch_youtube_transcript", {"url": url.group(0)})
        quoted = QUOTED_RE.search(text)
        title = quoted.group(1) if quoted else _first_sentence(text, 40)
        if ("song" in lower or "lyrics" in lower) and "find_song_facts" in tools:
            return self._call("find_song_facts", {"title": title})
        if ("song" in lower or "lyrics" in lower) and "find_song_lyrics" in tools:
            return self._call("find_song_lyrics", {"title": title})
        if "podcast" in lower and "find_podcast_transcript" in tools:
            return self._call("find_podcast_transcript", {"show": title})
        if ("book" in lower or "finished" in lower) and "find_book_facts" in tools:
            return self._call("find_book_facts", {"title": title})
        if ("movie" in lower or "film" in lower) and "find_movie_facts" in tools:
            return self._call("find_movie_facts", {"title": title})
        return None

    @staticmethod
    def _lookup_note(responses) -> str:
        for r in responses:
            payload = r.response if isinstance(r.response, dict) else {}
            if not payload.get("ok"):
                continue
            detail = payload.get("text") or payload.get("lyrics") or ", ".join(
                str(payload[k]) for k in ("title", "artist", "album", "author",
                                          "year", "director", "show", "episode",
                                          "plot")
                if payload.get(k))
            if detail:
                return f"\n\nFrom the lookup, kept in the margin: {detail[:400]}"
        return ""

    def _keeper_tell(self, req, system) -> types.Content:
        text = self._last_user_text(req)
        responses = self._function_responses(req)
        if not responses:
            call = self._lookup_call(req, text)
            if call is not None:
                return call
        extends = self._extends_slug(text, system)
        title = _first_sentence(text, 60) or "A new memory"
        tags = sorted(_words(text))[:3]
        entities = list(dict.fromkeys(ENTITY_RE.findall(text)))[:4]
        names = ", ".join(entities) if entities else "no one by name"
        body = "\n\n".join([
            f"# {title}", text,
            f"The shelf keeps the day with it. This one names {names}, and it "
            f"was told plainly, the way memories arrive before they settle. "
            f"What it carries sits beside the older books now, close enough "
            f"to touch spines.",
            f"Margin note: bound the evening it was told, filed under "
            f"{', '.join(tags) if tags else 'no tags yet'}.",
        ])
        body += self._lookup_note(responses)
        if extends:
            return self._text({
                "reply": "I have added it to the book.",
                "title": title, "tags": tags, "entities": entities,
                "one_liner": _first_sentence(text, 140) + ".",
                "body_md": text, "extends_slug": extends,
            })
        return self._text({
            "reply": f"It is on the shelf now: {title}.",
            "title": title, "tags": tags, "entities": entities,
            "one_liner": _first_sentence(text, 140) + ".",
            "body_md": body,
        })

    @staticmethod
    def _extends_slug(text: str, system: str) -> str | None:
        """A follow-up cue plus word overlap with a shelved slug = extension."""
        lower = text.lower()
        if not lower.startswith(("also", "and ", "yes", "one more")):
            return None
        slugs = list(dict.fromkeys(SLUG_RE.findall(system)))
        scored = sorted(((len(_words(text) & _words(s.replace("-", " "))), s)
                         for s in slugs), key=lambda p: (-p[0], p[1]))
        return scored[0][1] if scored and scored[0][0] > 0 else None

    def _keeper_ask(self, req, system) -> types.Content:
        responses = self._function_responses(req)
        if responses:
            books = [r.response for r in responses if isinstance(r.response, dict)]
            slugs = [b.get("slug", "") for b in books if b.get("slug")]
            first = books[0] if books else {}
            answer = f"On {first.get('date', 'that day')} you told me: " \
                     f"{_first_sentence(first.get('body_md', ''), 140)}."
            return self._text({"answer": answer, "used_slugs": slugs,
                               "needs_followup": False})
        question = self._last_user_text(req)
        question_words = _words(question)
        asked_dates = re.findall(r"\d{4}-\d{2}-\d{2}", question)
        slugs = list(dict.fromkeys(SLUG_RE.findall(system)))
        scored = sorted(((len(question_words & _words(s.replace('-', ' ')))
                          + (10 if any(s.startswith(d) for d in asked_dates) else 0), s)
                         for s in slugs), key=lambda p: (-p[0], p[1]))
        if scored and scored[0][0] > 0:
            return self._call("read_book", {"slug": scored[0][1]})
        return self._text({"answer": "I have nothing on my shelves about that yet. "
                                     "Want me to keep it as a new memory?",
                           "used_slugs": [], "needs_followup": True})

    def _monument(self, req, system) -> types.Content:
        responses = self._function_responses(req)
        if responses:
            r = responses[-1]
            body = r.response if isinstance(r.response, dict) else {"result": r.response}
            if r.name == "create_keeper":
                topic = body.get("topic", "it")
                return self._text(f"Done. The keeper of {topic} has her house now.")
            return self._text(f"Here is what came back: {json.dumps(body)}")
        text = self._last_user_text(req)
        wanted = re.search(r"keeper (?:for|of|about) ([a-zA-Z ]{3,40})", text)
        if wanted and re.search(r"\b(create|new|make|want)\b", text.lower()):
            return self._call("create_keeper", {"topic": wanted.group(1).strip()})
        for tool_name in req.tools_dict:
            root = tool_name.replace("ask_", "").replace("_", " ")
            if tool_name not in ("create_keeper", "list_keepers") and root in text.lower():
                return self._call(tool_name, {"request": text})
        return self._text("I watch over the whole island. Ask me to create a keeper, "
                          "or ask what your memories share.")

    def _dream_write(self, req, system) -> types.Content:
        text = self._last_user_text(req)
        elements = re.findall(r"element: ([^\n]+)", text) or ["something unnamed"]
        head = elements[0]
        return self._text({
            "name": f"The one who circles {head}",
            "persona": f"Born at night from everything that keeps returning to {head}. "
                       "Speaks in half-finished sentences.",
            "body_md": "While the island slept, the same shape surfaced in different "
                       f"shelves: {', '.join(elements)}. It is not a coincidence. It "
                       "waits to be looked at directly.",
            "one_liner": f"A night reading about {head}.",
        })

    def _dream_narrative(self, req, system) -> types.Content:
        text = self._last_user_text(req)
        themes = re.findall(r"theme: ([^\n]+)", text)
        if themes:
            return self._text({"narrative": "The island dreamed. "
                               f"{len(themes)} thread(s) surfaced: {', '.join(themes)}."})
        return self._text({"narrative": "The island dreamed quietly; nothing new "
                                        "surfaced, and the shelves rest."})

    def _plain(self, req, system) -> types.Content:
        return self._text(f"heard: {_first_sentence(self._last_user_text(req), 80)}")
