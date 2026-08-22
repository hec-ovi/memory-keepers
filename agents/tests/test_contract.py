"""Pins agents/CONTRACT.md through AgentsApi with the fake tier."""
from datetime import date, timedelta

import pytest
from mk_library import LIBRARY_CAP, LibraryError


async def test_tell_writes_grounded_book_and_records(api, library):
    told = "I dreamed of Harbor Tower again. Never tell Luna about this."
    out = await api.keeper_tell("w", "dreams", told)
    assert out["book"]["source"] == "told"
    assert "Harbor Tower" in out["book"]["entities"]
    assert out["reply"]
    body = library.get_book("w", "dreams", out["book"]["slug"]).body_md
    assert told in body and len(body) > len(told)  # the keeper authors the book

    session = library.session_read("w", "dreams")
    assert [t.role for t in session.turns] == ["user", "keeper"]
    assert any("Never tell Luna" in c for c in session.blocks["constraints"])
    assert library.get_keeper("w", "dreams").tokens_used > 0


async def test_tell_dark_keeper_never_writes(api, library):
    library.create_keeper("w", "the climb", side="dark", archetype="ambition")
    out = await api.keeper_tell("w", "the-climb", "I want the summit.")
    assert out["book"] is None
    assert library.get_keeper("w", "the-climb").book_count == 0


async def test_tell_full_bookcase_raises_but_records(api, library):
    have = library.get_keeper("w", "music").book_count
    for i in range(LIBRARY_CAP - have):
        library.write_book("w", "music", title=f"filler {i}", body_md="x",
                           date="2026-08-01", source="told", one_liner="f")
    with pytest.raises(LibraryError) as e:
        await api.keeper_tell("w", "music", "One more song to keep.")
    assert e.value.code == "LIBRARY_FULL"
    assert len(library.session_read("w", "music").turns) == 2


async def test_capture_runs_the_lookup_into_the_book(api, library, lookups):
    out = await api.keeper_tell("w", "music", 'Can you save this song? "Money" by Pink Floyd')
    assert ("song_facts", "Money") in lookups.calls
    body = library.get_book("w", "music", out["book"]["slug"]).body_md
    assert "1973" in body and "The Dark Side of the Moon" in body

    out = await api.keeper_tell("w", "music", 'Keep the lyrics of "Money" for me.')
    assert ("lyrics", "Money") in lookups.calls
    body = library.get_book("w", "music", out["book"]["slug"]).body_md
    assert "is this the real life" in body


async def test_follow_up_grows_the_same_book(api, library):
    keeper = library.create_keeper("w", "movies")
    first = await api.keeper_tell(
        "w", keeper.id, 'I watched the movie "Inception" yesterday and loved it.')
    slug = first["book"]["slug"]
    count = library.get_keeper("w", keeper.id).book_count

    grown = await api.keeper_tell(
        "w", keeper.id, "Also, what I liked from Inception was the spinning ending.")
    assert grown["book"] is None
    assert grown["book_grown"]["slug"] == slug
    body = library.get_book("w", keeper.id, slug).body_md
    assert "## Added" in body and "spinning ending" in body
    assert library.get_keeper("w", keeper.id).book_count == count  # grew, not minted


async def test_say_routes_small_talk_to_a_reply_without_a_book(api, library):
    count = library.get_keeper("w", "dreams").book_count
    out = await api.keeper_say("w", "dreams", "hello")
    assert out["kind"] == "talk" and out["reply"] and out["book"] is None
    assert library.get_keeper("w", "dreams").book_count == count
    assert [t.role for t in library.session_read("w", "dreams").turns] == ["user", "keeper"]


async def test_passing_remarks_land_in_the_one_notes_book(api, library):
    keeper = library.create_keeper("w", "movies")
    first = await api.keeper_tell(
        "w", keeper.id, 'I watched the movie "Inception" yesterday and loved it.')
    count = library.get_keeper("w", keeper.id).book_count

    out = await api.keeper_tell("w", keeper.id, "I liked the spinning top in Inception.")
    assert out["book"] is None and out["book_grown"]["slug"] == "notes"
    again = await api.keeper_tell("w", keeper.id, "I hate slow openings.")
    assert again["book_grown"]["slug"] == "notes"

    notes = library.get_book("w", keeper.id, "notes")
    assert notes.body_md.count("## 20") == 2 and "spinning top" in notes.body_md
    assert notes.links == [first["book"]["slug"]]  # the remark points at the film's book
    assert library.get_keeper("w", keeper.id).book_count == count + 1  # one notes book, once


def test_resolve_date_exists_only_for_messages_with_a_relative_day(api):
    assert api._date_tool("I worked at Ohara from Mar 2025 to Jan 2026.") == []  # nothing to resolve
    resolve_date = api._date_tool("the interview is tomorrow, remember it")[0]
    assert resolve_date("tomorrow")["date"] == (date.today() + timedelta(days=1)).isoformat()
    assert resolve_date("next friday")["ok"] is False  # not in the message


async def test_a_model_that_keeps_calling_tools_stops_at_the_cap():
    from typing import AsyncGenerator
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types
    from mk_agents.runtime import MAX_LLM_CALLS, build_agent, run_agent

    calls = []

    def ping(phrase: str) -> dict:
        """Always a tool call, never an answer."""
        calls.append(phrase)
        return {"ok": False}

    class LoopingLlm(BaseLlm):
        model: str = "loop-1"

        async def generate_content_async(self, llm_request, stream=False) -> AsyncGenerator[LlmResponse, None]:
            yield LlmResponse(content=types.Content(role="model", parts=[
                types.Part(function_call=types.FunctionCall(name="ping", args={"phrase": "again"}))]))

    with pytest.raises(Exception):
        await run_agent(build_agent("loop", LoopingLlm(), "loop forever", [ping]), "go")
    assert len(calls) <= MAX_LLM_CALLS


def test_wording_router_without_a_model():
    from mk_agents.fallbacks import route_by_wording
    assert route_by_wording("hello") == "talk"
    assert route_by_wording("save this") == "tell"
    assert route_by_wording("what did I dream?") == "ask"
    assert route_by_wording("I want the summit today.") == "tell"


async def test_ask_grounded_with_sources(api):
    out = await api.keeper_ask("w", "dreams", "what did I dream about the deer?")
    assert out["grounded"] and not out["followup"]
    assert out["sources"][0]["slug"] == "2026-08-18-the-deer-in-the-forest"
    assert "deer" in out["answer"].lower() or "forest" in out["answer"].lower()


async def test_ask_unknown_topic_offers_followup(api, library):
    library.create_keeper("w", "recipes")
    out = await api.keeper_ask("w", "recipes", "what about the zebra?")
    assert not out["grounded"] and out["followup"] and out["sources"] == []


async def test_ask_resolves_relative_dates(api, library):
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    library.write_book("w", "dreams", title="Rehearsing the docking", date=yesterday,
                       source="told", one_liner="A dream about the docking run.",
                       body_md="I practiced the docking run until it felt easy.")
    out = await api.keeper_ask("w", "dreams", "what did I tell you yesterday about the docking?")
    assert out["grounded"]
    assert out["sources"][0]["date"] == yesterday
    assert yesterday in out["answer"]  # the resolved day reached the reply


async def test_ask_model_reply_without_slugs_falls_back(library):
    """CONTRACT: no exception escapes a flow because of a model reply shape."""
    from mk_agents import AgentsApi
    from mk_models.fake_llm import FakeLlm

    class SluglessLlm(FakeLlm):
        def _keeper_ask(self, req, system):
            return self._text({"answer": "The launch went well."})

    class SluglessGateway:
        def model_for(self, role):
            return SluglessLlm()

    library.ensure_world("w")
    api = AgentsApi(library, SluglessGateway())
    out = await api.keeper_ask("w", "dreams", "what did I dream about the launch?")
    assert out["answer"] and out["grounded"] and out["sources"]


def test_chatter_comes_from_books_after_a_consolidation(api, library):
    from mk_agents.chatter import BUCKET_SECONDS, pick
    assert api.keeper_chatter("w", "dreams") is None  # silent before the first dreaming
    library.create_keeper("w", "calls")  # an empty shelf
    library.write_book("w", "dreams", title="The long corridor " * 6, body_md="x",
                       date="2026-08-10", source="told",
                       one_liner="A corridor that never ended, " * 6)
    counts = api.refresh_chatter("w")
    assert counts["dreams"] >= 3 and counts["calls"] == 0  # calls holds no books
    assert api.keeper_chatter("w", "calls") is None
    books = library.list_books("w", "dreams")
    allowed = {b.one_liner for b in books} | {f"Ask me about {b.title}." for b in books}
    lines = library.get_keeper("w", "dreams").chatter
    assert all(len(line) < 90 for line in lines)
    assert all(line in allowed or line.endswith("...") for line in lines)
    assert len({pick(lines, "dreams", now=i * BUCKET_SECONDS) for i in range(10)}) > 1  # rotates


def test_resolve_phrase_turns_relative_days_into_calendar_days():
    from mk_agents.dates import resolve_phrase
    today = date(2026, 8, 22)  # a Saturday
    cases = {
        "tomorrow": date(2026, 8, 23), "in two weeks": date(2026, 9, 5),
        "in 3 days": date(2026, 8, 25), "3 days ago": date(2026, 8, 19),
        "next friday": date(2026, 8, 28), "friday": date(2026, 8, 28),
        "this saturday": date(2026, 8, 22), "next saturday": date(2026, 8, 29),
        "next month": date(2026, 9, 22), "march 3": date(2027, 3, 3),
        "3rd of march": date(2027, 3, 3), "2026-12-01": date(2026, 12, 1),
    }
    for phrase, day in cases.items():
        assert resolve_phrase(phrase, today) == day, phrase
    assert resolve_phrase("whenever", today) is None


async def test_tell_writes_the_calendar_date_not_the_phrase(api, library):
    out = await api.keeper_tell("w", "dreams", "I have a job interview tomorrow, remember it.")
    body = library.get_book("w", "dreams", out["book"]["slug"]).body_md
    assert (date.today() + timedelta(days=1)).isoformat() in body


async def test_ridge_keeper_reads_any_shelf_and_asks(api, library):
    seeded = library.list_books("w", "dreams")[0]
    dark = library.create_keeper("w", "the deer", side="dark", archetype="obsession")
    library.write_book("w", dark.id, title="The one who circles the deer", body_md="It returns.",
                       date="2026-08-20", source="dream", one_liner="A night reading.",
                       links=[f"dreams/{seeded.slug}"], enforce_cap=False)
    out = await api.keeper_say("w", dark.id, "why does the deer keep coming back?")
    assert out["kind"] == "talk" and out["book"] is None
    assert out["reply"].rstrip().endswith("?")
    assert out["sources"] == [f"dreams/{seeded.slug}"]  # opened across the village
    assert library.get_keeper("w", dark.id).book_count == 1  # nothing written


async def test_monument_creates_keeper(api, library):
    out = await api.monument_chat("w", "I want a new keeper for films")
    assert out["created_keeper"]["topic"] == "films"
    assert library.get_keeper("w", "films").side == "light"
    assert out["reply"]


async def test_monument_routes_to_keeper(api):
    out = await api.monument_chat("w", "ask my dreams shelf about the deer")
    assert out["created_keeper"] is None
    assert "deer" in out["reply"]  # the dreams keeper's deer book came back


async def test_dream_prose_shapes(api):
    written = await api.dream_write("ambition", ["Mars mission"], ["two shelves cite it"])
    assert set(written) == {"name", "persona", "body_md", "one_liner"}
    assert "Mars mission" in written["body_md"]
    narrative = await api.dream_narrative(["mars-mission"])
    assert "1 thread" in narrative
    assert "quiet" in (await api.dream_narrative([])).lower()
