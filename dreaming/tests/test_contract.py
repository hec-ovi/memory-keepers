"""Pins dreaming/CONTRACT.md: linking, dark births, caps, idempotence, narrative."""
import pytest
from mk_agents import AgentsApi
from mk_dreaming import run_dream
from mk_dreaming.linking import link
from mk_library import DARK_CAP, LIBRARY_CAP, Library, seed
from mk_library.testing import FakeFirestore
from mk_models import ModelGateway


@pytest.fixture
def rig():
    library = Library(FakeFirestore(), seed=seed.apply)
    library.ensure_world("w")
    return library, AgentsApi(library, ModelGateway(tier="fake"))


def test_linking_finds_cross_keeper_themes(rig):
    library, _ = rig
    books = {k.id: library.list_books("w", k.id) for k in library.list_keepers("w")}
    graph, themes = link(books)
    keys = [t["key"] for t in themes]
    assert "mars-mission" in keys and "aurora" in keys
    mars = next(t for t in themes if t["key"] == "mars-mission")
    assert len(mars["keepers"]) >= 2 and mars["archetype"] == "ambition"
    assert any(n["kind"] == "entity" for n in graph["nodes"])
    assert any(e["kind"] == "mentions" for e in graph["edges"])


async def test_dream_births_dark_side(rig):
    library, agents_api = rig
    report = await run_dream(library, agents_api, "w", reason="nightly")
    assert report["status"] == "done" and report["reason"] == "nightly"
    dark = [k for k in library.list_keepers("w") if k.side == "dark"]
    assert dark and all(k.archetype for k in dark)
    assert report["created_books"]
    first = report["created_books"][0]
    book = library.get_book("w", first["keeper_id"], first["book"]["slug"])
    assert book.source == "dream" and book.links  # cites real sources
    assert any(e["kind"] == "derived_from" for e in report["graph"]["edges"])
    assert report["narrative"]


async def test_dream_is_idempotent_on_unchanged_sources(rig):
    library, agents_api = rig
    first = await run_dream(library, agents_api, "w", "nightly")
    second = await run_dream(library, agents_api, "w", "nightly")
    assert second["run_id"] != first["run_id"]
    assert second["created_books"] == [] and second["created_keepers"] == []


async def test_dream_never_breaks_caps(rig):
    library, agents_api = rig
    for i in range(DARK_CAP + 2):  # more shared themes than dark plots
        for kid in ("dreams", "music"):
            library.write_book("w", kid, title=f"about Shared Thing {i}",
                               body_md=f"It keeps returning again to Shared Thing {i}.",
                               date="2026-08-07", source="told", one_liner="s",
                               entities=[f"Shared Thing {i}"])
    report = await run_dream(library, agents_api, "w", "nightly")
    dark = [k for k in library.list_keepers("w") if k.side == "dark"]
    assert len(dark) <= DARK_CAP
    assert all(library.get_keeper("w", k.id).book_count <= LIBRARY_CAP for k in dark)


async def test_failed_run_settles_as_failed(rig):
    library, _ = rig

    class Boom:  # the seeded world has themes, so dream_write is always reached
        async def dream_write(self, *a, **k):
            raise RuntimeError("boom")

        async def dream_narrative(self, *a, **k):
            raise RuntimeError("boom")

    report = await run_dream(library, Boom(), "w", "nightly")
    assert report["status"] == "failed" and "boom" in report["error"]
