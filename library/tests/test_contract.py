"""Pins library/CONTRACT.md: every method, error and cap once."""
import pytest
from mk_library import DARK_CAP, LIBRARY_CAP, LIGHT_CAP, LibraryError, Library
from mk_library.records import Turn
from mk_library.testing import FakeFirestore


def test_ensure_world_seeds_once(library):
    library.ensure_world("w1")
    keepers = library.list_keepers("w1")
    assert {k.topic for k in keepers} == {"dreams", "books", "music"}
    assert all(k.side == "light" and k.level >= 2 for k in keepers)
    library.ensure_world("w1")  # idempotent
    assert len(library.list_keepers("w1")) == 3


def test_world_meta_unknown_world(library):
    with pytest.raises(LibraryError) as e:
        library.world_meta("nope")
    assert e.value.code == "WORLD_NOT_FOUND"


def test_keeper_lifecycle_and_errors(library, world):
    k = library.create_keeper(world, "Places I Visited")
    assert k.id == "places-i-visited" and k.side == "light"
    assert k.palette["primary"].startswith("#")
    assert library.get_keeper(world, k.id).name == "Keeper of Places I Visited"

    with pytest.raises(LibraryError) as e:
        library.create_keeper(world, "places i visited")
    assert e.value.code == "KEEPER_EXISTS"

    library.delete_keeper(world, k.id)
    with pytest.raises(LibraryError) as e:
        library.get_keeper(world, k.id)
    assert e.value.code == "KEEPER_NOT_FOUND"


def test_caps_per_side(library, world):
    for i in range(LIGHT_CAP - 3):  # 3 seeded
        library.create_keeper(world, f"topic {i}")
    with pytest.raises(LibraryError) as e:
        library.create_keeper(world, "one too many")
    assert e.value.code == "KEEPERS_FULL"

    for i in range(DARK_CAP):
        library.create_keeper(world, f"shadow {i}", side="dark", archetype="fear")
    with pytest.raises(LibraryError) as e:
        library.create_keeper(world, "ninth shadow", side="dark", archetype="fear")
    assert e.value.code == "KEEPERS_FULL"


def test_book_lifecycle(library, world):
    book = library.write_book(
        world, "dreams", title="The station clock", body_md="x" * 500,
        date="2026-08-08", source="told", one_liner="A clock that runs backwards.",
        tags=["time"], entities=["Station"])
    assert book.slug == "2026-08-08-the-station-clock" and book.tier == "medium"

    dup = library.write_book(world, "dreams", title="The station clock",
                             body_md="y", date="2026-08-08", source="told",
                             one_liner="Again.")
    assert dup.slug.endswith("-2")

    books = library.list_books(world, "dreams")
    assert books[0].date >= books[-1].date and len(books) == 3
    assert library.get_keeper(world, "dreams").book_count == 3

    full = library.get_book(world, "dreams", book.slug)
    assert full.body_md.startswith("x")
    rows = library.index_rows(world, "dreams")
    assert "body_md" not in rows[0] and rows[0]["slug"]

    library.delete_book(world, "dreams", dup.slug)
    assert library.get_keeper(world, "dreams").book_count == 2
    with pytest.raises(LibraryError) as e:
        library.get_book(world, "dreams", dup.slug)
    assert e.value.code == "BOOK_NOT_FOUND"


def test_library_cap(library, world):
    have = len(library.list_books(world, "music"))
    for i in range(LIBRARY_CAP - have):
        library.write_book(world, "music", title=f"song {i}", body_md="b",
                           date="2026-08-08", source="told", one_liner="s")
    with pytest.raises(LibraryError) as e:
        library.write_book(world, "music", title="over", body_md="b",
                           date="2026-08-08", source="told", one_liner="s")
    assert e.value.code == "LIBRARY_FULL"
    # dreaming and sleep may bypass while they merge room free
    library.write_book(world, "music", title="digest", body_md="b", date="2026-08-08",
                       source="sleep", one_liner="s", enforce_cap=False)
    assert len(library.list_books(world, "music")) == LIBRARY_CAP + 1


def test_session_and_meter(library, world):
    s = library.session_read(world, "dreams")
    assert s.turns == [] and s.blocks["constraints"] == []

    library.session_append(world, "dreams",
                           [Turn(t="2026-08-08T10:00:00Z", role="user", text="hi")],
                           constraints=["never tell Luna about the door"])
    library.session_append(world, "dreams",
                           [Turn(t="2026-08-08T10:01:00Z", role="keeper", text="hello")],
                           constraints=["never tell Luna about the door"])
    s = library.session_read(world, "dreams")
    assert len(s.turns) == 2 and s.blocks["constraints"] == ["never tell Luna about the door"]

    s.blocks["recent_topics"] = ["the user works on the Mars mission"]
    s.turns = s.turns[-1:]
    s.sleep_count = 1
    library.session_replace(world, "dreams", s)
    assert library.session_read(world, "dreams").sleep_count == 1

    assert library.meter_add(world, "dreams", 500) == 500
    assert library.meter_add(world, "dreams", 250) == 750
    library.meter_reset(world, "dreams", 100)
    assert library.get_keeper(world, "dreams").tokens_used == 100
    assert library.get_keeper(world, "dreams").payload(budget=1000)["session"]["status"] == "rested"


def test_dream_runs(library, world):
    with pytest.raises(LibraryError) as e:
        library.dream_latest(world)
    assert e.value.code == "DREAM_NOT_FOUND"

    run = library.dream_start(world, reason="nightly")
    assert run.run_id == "run-0001" and run.status == "running"
    library.dream_update(world, run.run_id, status="done", narrative="quiet night")
    assert library.dream_get(world, run.run_id).narrative == "quiet night"
    assert library.dream_latest(world).run_id == run.run_id
    assert library.dream_start(world, "tired").run_id == "run-0002"


def test_unseeded_library_starts_empty():
    lib = Library(FakeFirestore())  # no seed callable
    lib.ensure_world("bare")
    assert lib.list_keepers("bare") == []


def test_make_room_digest_merge(library, world):
    have = len(library.list_books(world, "dreams"))
    for i in range(LIBRARY_CAP - have):
        library.write_book(world, "dreams", title=f"old {i}", body_md=f"body {i}",
                           date=f"2026-07-{(i % 28) + 1:02d}", source="told", one_liner="o")
    digests, fits = library.make_room(world, "dreams", incoming=1)
    assert fits and digests
    books = library.list_books(world, "dreams")
    assert len(books) <= LIBRARY_CAP - 2  # room for the incoming book plus a spare
    digest = library.get_book(world, "dreams", digests[-1].slug)  # earlier digests may fold again
    assert digest.source == "sleep" and len(digest.links) >= 2
    for merged_slug in digest.links[:2]:
        assert merged_slug.split("/")[-1] in digest.body_md  # nothing lost


def test_append_to_book_grows_body_and_tier(library):
    library.ensure_world("w")
    keeper = library.create_keeper("w", "walks")
    book = library.write_book("w", keeper.id, title="A short walk", body_md="one line",
                              date="2026-08-11", source="told", one_liner="a walk")
    grown = library.append_to_book("w", keeper.id, book.slug,
                                   note_md="the long part " * 200, date="2026-08-12")
    assert grown.slug == book.slug
    assert "## Added 2026-08-12" in grown.body_md and grown.body_md.startswith("one line")
    assert grown.tier != book.tier  # size re-derived
    assert library.get_keeper("w", keeper.id).book_count == 1


def test_append_note_keeps_one_notes_book_per_keeper(library):
    library.ensure_world("w")
    keeper = library.create_keeper("w", "films")
    film = library.write_book("w", keeper.id, title="Inception night", body_md="seen",
                              date="2026-08-11", source="told", one_liner="a film")
    note = library.append_note("w", keeper.id, note_md="Liked the ending.", date="2026-08-12",
                               tags=["ending"], about=[film.slug])
    assert (note.slug, note.source, note.links) == ("notes", "notes", [film.slug])
    again = library.append_note("w", keeper.id, note_md="Slow openings bore me.",
                                date="2026-08-13", tags=["pace"])
    assert again.body_md.count("## 2026-08-1") == 2 and again.tags == ["ending", "pace"]
    assert library.get_keeper("w", keeper.id).book_count == 2  # the notes book counts once
    assert library.list_books("w", keeper.id)[0].slug == "notes"  # dated by its latest entry
    for i in range(LIBRARY_CAP):
        try:
            library.write_book("w", keeper.id, title=f"filler {i}", body_md="x",
                               date="2026-08-01", source="told", one_liner="f")
        except LibraryError:
            break
    library.make_room("w", keeper.id, incoming=1)
    assert library.get_book("w", keeper.id, "notes").links == [film.slug]  # never bound away


def test_world_travel_round_trip(library, world):
    library.write_book(world, "dreams", title="Travel proof", body_md="carried",
                       date="2026-08-12", source="told", one_liner="travels")
    library.session_append(world, "dreams",
                           [Turn(t="2026-08-12T00:00:00Z", role="user", text="hi")],
                           constraints=["never spoilers"])
    run = library.dream_start(world, "asked")
    library.dream_update(world, run.run_id, status="done")

    data = library.export_world(world)
    assert data["format"] == "memory-keepers-world" and data["version"] == 1

    target = f"{world}-copy"
    out = library.import_world(target, data)
    assert out["keepers"] == len(library.list_keepers(world))
    assert ({b.slug for b in library.list_books(target, "dreams")}
            == {b.slug for b in library.list_books(world, "dreams")})
    slug = library.list_books(world, "dreams")[0].slug
    assert library.get_book(target, "dreams", slug).body_md == \
        library.get_book(world, "dreams", slug).body_md
    assert "never spoilers" in library.session_read(target, "dreams").blocks["constraints"]
    assert library.dream_latest(target).run_id == run.run_id
    assert library.get_keeper(target, "dreams").sleep_job is None


def test_world_import_rejects_bad_files(library, world):
    data = library.export_world(world)
    with pytest.raises(LibraryError) as e:
        library.import_world(world, data)  # target already exists
    assert e.value.code == "IMPORT_INVALID"
    with pytest.raises(LibraryError) as e:
        library.import_world(f"{world}-bad", {"format": "something-else"})
    assert e.value.code == "IMPORT_INVALID"
    over = dict(data, keepers=[dict(data["keepers"][0], id=f"k{i}", books=[])
                               for i in range(LIGHT_CAP + 1)])
    with pytest.raises(LibraryError) as e:
        library.import_world(f"{world}-over", over)
    assert e.value.code == "IMPORT_INVALID"


def test_delete_world_removes_everything(library, world):
    run = library.dream_start(world, "asked")
    library.dream_update(world, run.run_id, status="done")
    library.delete_world(world)
    assert world not in library.list_worlds()
    with pytest.raises(LibraryError):
        library.world_meta(world)
