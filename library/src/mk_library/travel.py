"""World travel: a whole world serialized to one portable dict and back.

File format, version 1:
  {format, version, exported_at, meta,
   keepers: [{...keeper, books: [...], session: {...}}], dreams: [...]}
Import targets a world that does not exist yet; records are re-parsed through
their dataclasses so only known fields survive the trip.
"""
from .errors import LibraryError
from .limits import DARK_CAP, LIBRARY_CAP, LIGHT_CAP
from .records import Book, DreamRun, Keeper, Session
from .store import now_iso

FORMAT = "memory-keepers-world"
VERSION = 1


def export_world(library, wid: str) -> dict:
    keepers = []
    for keeper in library.list_keepers(wid):
        keepers.append(keeper.to_doc() | {
            "books": [b.to_doc() for b in library.list_books(wid, keeper.id)],
            "session": library.session_read(wid, keeper.id).to_doc(),
        })
    return {"format": FORMAT, "version": VERSION, "exported_at": now_iso(),
            "meta": library.world_meta(wid), "keepers": keepers,
            "dreams": [d.to_doc() for d in library.list_dreams(wid)]}


def _parse(data) -> tuple[list[tuple[Keeper, list[Book], Session]], list[DreamRun]]:
    try:
        keepers = []
        for entry in data.get("keepers", []):
            keeper = Keeper.from_doc(entry)
            books = [Book.from_doc(b) for b in entry.get("books", [])]
            for book in books:
                if not (book.slug and book.title and isinstance(book.body_md, str)):
                    raise LibraryError("IMPORT_INVALID", "book missing slug/title/body")
            if not (keeper.id and keeper.name and keeper.side in ("light", "dark")):
                raise LibraryError("IMPORT_INVALID", "keeper missing id/name/side")
            keepers.append((keeper, books, Session.from_doc(entry.get("session"))))
        dreams = [DreamRun.from_doc(d) for d in data.get("dreams", [])]
        for run in dreams:
            if not run.run_id:
                raise LibraryError("IMPORT_INVALID", "dream run missing run_id")
    except (TypeError, AttributeError):
        raise LibraryError("IMPORT_INVALID", "malformed world file")
    return keepers, dreams


def import_world(library, wid: str, data) -> dict:
    if (not isinstance(data, dict) or data.get("format") != FORMAT
            or data.get("version") != VERSION):
        raise LibraryError("IMPORT_INVALID", "not a memory-keepers world file")
    if library._world(wid).get().exists:
        raise LibraryError("IMPORT_INVALID", "target world already exists")
    keepers, dreams = _parse(data)
    for side, cap in (("light", LIGHT_CAP), ("dark", DARK_CAP)):
        if sum(1 for k, _, _ in keepers if k.side == side) > cap:
            raise LibraryError("IMPORT_INVALID", f"too many {side} keepers")
    if any(len(books) > LIBRARY_CAP for _, books, _ in keepers):
        raise LibraryError("IMPORT_INVALID", "a library holds at most "
                                             f"{LIBRARY_CAP} books")

    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    run_ids = {run.run_id for run in dreams}
    library._world(wid).set({
        "created_at": meta.get("created_at") or now_iso(),
        "seeded": bool(meta.get("seeded")),
        "dream_counter": int(meta.get("dream_counter") or 0),
        "latest_run_id": meta.get("latest_run_id")
        if meta.get("latest_run_id") in run_ids else None,
    })
    for keeper, books, session in keepers:
        keeper.book_count = len(books)
        keeper.sleep_job = None  # a job from the old process cannot be running here
        library._keeper(wid, keeper.id).set(keeper.to_doc())
        for book in books:
            library._book(wid, keeper.id, book.slug).set(book.to_doc())
        library._session_ref(wid, keeper.id).set(session.to_doc())
    for run in dreams:
        library._world(wid).collection("dreams").document(run.run_id).set(run.to_doc())
    return {"keepers": len(keepers),
            "books": sum(len(books) for _, books, _ in keepers)}
