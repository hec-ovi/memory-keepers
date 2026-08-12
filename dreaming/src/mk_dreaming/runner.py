"""One dream run for one world: link, birth the dark side, persist the report."""
import logging

from mk_library import DARK_CAP, Library, LibraryError
from mk_library.store import now_iso

from .linking import link

log = logging.getLogger(__name__)


async def run_dream(library: Library, agents_api, world: str, reason: str,
                    run_id: str | None = None) -> dict:
    if run_id is None:
        run_id = library.dream_start(world, reason).run_id
    else:  # the caller queued the run up front; take it over
        library.dream_update(world, run_id, status="running", started_at=now_iso())
    try:
        report = await _dream(library, agents_api, world)
        library.dream_update(world, run_id, status="done",
                             finished_at=now_iso(), **report)
    except Exception as e:  # a dream must always settle
        log.exception("dream run failed")
        library.dream_update(world, run_id, status="failed",
                             finished_at=now_iso(), error=str(e))
    return library.dream_get(world, run_id).to_doc()


async def _dream(library: Library, agents_api, world: str) -> dict:
    keepers = library.list_keepers(world)
    light_books = {k.id: library.list_books(world, k.id)
                   for k in keepers if k.side == "light"}
    graph, themes = link(light_books)

    dark = {k.topic: k for k in keepers if k.side == "dark"}
    created_keepers, created_books, skipped = [], [], []
    for theme in themes[:DARK_CAP]:
        evidence = [f"{e['title']}: {e['body_md'][:200]}" for e in theme["evidence"]]
        evidence_slugs = [f"{e['keeper_id']}/{e['slug']}" for e in theme["evidence"]]
        keeper = dark.get(theme["key"])
        if keeper is None:
            try:
                prose = await agents_api.dream_write(
                    theme["archetype"], [theme["element"]], evidence)
                keeper = library.create_keeper(
                    world, theme["key"], name=prose["name"], persona=prose["persona"],
                    side="dark", archetype=theme["archetype"])
                dark[theme["key"]] = keeper
                created_keepers.append(keeper.payload())
            except LibraryError:
                skipped.append({"key": theme["key"], "archetype": theme["archetype"]})
                continue
        else:
            already = {s for b in library.list_books(world, keeper.id) for s in b.links}
            if set(evidence_slugs) <= already:
                continue  # this reading already exists; recreate only when sources change
            prose = await agents_api.dream_write(
                theme["archetype"], [theme["element"]], evidence)

        _, fits = library.make_room(world, keeper.id, incoming=1)
        if not fits:
            skipped.append({"key": theme["key"], "archetype": theme["archetype"]})
            continue
        book = library.write_book(
            world, keeper.id, title=prose["name"], body_md=prose["body_md"],
            date=now_iso()[:10], source="dream", one_liner=prose["one_liner"],
            tags=[theme["archetype"], theme["kind"]], entities=[theme["element"]],
            links=evidence_slugs, enforce_cap=False)
        created_books.append({"keeper_id": keeper.id, "book": book.summary()})
        bid = f"book:{keeper.id}/{book.slug}"
        graph["nodes"].append({"id": bid, "kind": "book", "label": book.title,
                               "keeper_id": keeper.id, "weight": theme["weight"]})
        graph["edges"].extend(
            {"source": bid, "target": f"book:{ref}", "kind": "derived_from", "weight": 1}
            for ref in evidence_slugs)

    narrative = await agents_api.dream_narrative(
        [t["key"] for t in themes[:DARK_CAP]])
    return {"graph": graph, "narrative": narrative,
            "created_keepers": created_keepers, "created_books": created_books,
            "skipped_themes": skipped}
