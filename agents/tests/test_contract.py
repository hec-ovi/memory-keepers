"""Pins agents/CONTRACT.md through AgentsApi with the fake tier."""
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


async def test_tell_with_a_movie_runs_the_lookup_into_the_book(api, library, lookups):
    keeper = library.create_keeper("w", "movies")
    out = await api.keeper_tell(
        "w", keeper.id, 'I watched the movie "Inception" yesterday and loved it.')
    assert ("movie", "Inception") in lookups.calls
    body = library.get_book("w", keeper.id, out["book"]["slug"]).body_md
    assert "Christopher Nolan" in body  # the lookup result reached the shelf


async def test_capture_a_song_runs_the_facts_lookup_into_the_book(api, library, lookups):
    out = await api.keeper_tell("w", "music", 'Can you save this song? "Money" by Pink Floyd')
    assert ("song_facts", "Money") in lookups.calls
    body = library.get_book("w", "music", out["book"]["slug"]).body_md
    assert "1973" in body and "The Dark Side of the Moon" in body


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


async def test_ask_grounded_with_sources(api):
    out = await api.keeper_ask("w", "dreams", "what did I dream about the launch?")
    assert out["grounded"] and not out["followup"]
    assert out["sources"][0]["slug"] == "2026-08-05-rehearsing-the-launch"
    assert "countdown" in out["answer"] or "launch" in out["answer"].lower()


async def test_ask_unknown_topic_offers_followup(api, library):
    library.create_keeper("w", "recipes")
    out = await api.keeper_ask("w", "recipes", "what about the zebra?")
    assert not out["grounded"] and out["followup"] and out["sources"] == []


async def test_ask_resolves_relative_dates(api):
    out = await api.keeper_ask("w", "dreams", "what did I tell you on 2026-08-02?")
    assert out["grounded"]
    assert out["sources"][0]["date"] == "2026-08-02"


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


def test_chatter_rotates_and_matches_pool(api):
    from mk_agents.chatter import BUCKET_SECONDS, TOPIC_POOLS, line_for
    assert api.keeper_chatter("w", "dreams") in TOPIC_POOLS["dreams"]
    lines = {line_for("dreams", "dreams", "light", None, now=i * BUCKET_SECONDS)
             for i in range(10)}
    assert len(lines) > 5  # rotates
    assert all(len(line) < 90 for pool in TOPIC_POOLS.values() for line in pool)
    long_topic = "the complete recorded history of every conversation about my grandmother's garden"
    assert len(line_for("k", long_topic, "light", None)) < 90  # generic lines clamp too


async def test_monument_creates_keeper(api, library):
    out = await api.monument_chat("w", "I want a new keeper for films")
    assert out["created_keeper"]["topic"] == "films"
    assert library.get_keeper("w", "films").side == "light"
    assert out["reply"]


async def test_monument_routes_to_keeper(api):
    out = await api.monument_chat("w", "ask my dreams shelf about the launch")
    assert out["created_keeper"] is None
    assert out["reply"]


async def test_dream_prose_shapes(api):
    written = await api.dream_write("ambition", ["Mars mission"], ["two shelves cite it"])
    assert set(written) == {"name", "persona", "body_md", "one_liner"}
    assert "Mars mission" in written["body_md"]
    narrative = await api.dream_narrative(["mars-mission"])
    assert "1 thread" in narrative
    assert "quiet" in (await api.dream_narrative([])).lower()
