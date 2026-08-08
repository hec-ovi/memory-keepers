"""Pins agents/CONTRACT.md through AgentsApi with the fake tier."""
import pytest
from mk_library import LIBRARY_CAP, LibraryError


async def test_tell_writes_grounded_book_and_records(api, library):
    out = await api.keeper_tell(
        "w", "dreams", "I dreamed of Harbor Tower again. Never tell Luna about this.")
    assert out["book"]["source"] == "told"
    assert "Harbor Tower" in out["book"]["entities"]
    assert out["reply"]

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


def test_chatter_rotates_and_matches_pool(api):
    from mk_agents.chatter import BUCKET_SECONDS, TOPIC_POOLS, line_for
    assert api.keeper_chatter("w", "dreams") in TOPIC_POOLS["dreams"]
    lines = {line_for("dreams", "dreams", "light", None, now=i * BUCKET_SECONDS)
             for i in range(10)}
    assert len(lines) > 5  # rotates
    assert all(len(line) < 90 for pool in TOPIC_POOLS.values() for line in pool)


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
