"""The Library: every Firestore read and write in the project goes through this class.

The client is injected for tests (mk_library.testing.FakeFirestore) and honors
FIRESTORE_EMULATOR_HOST unchanged when the real client is used.
"""
from datetime import datetime, timezone

from .errors import LibraryError
from .limits import DARK_CAP, LIBRARY_CAP, LIGHT_CAP
from .palette import palette_for
from .records import Book, DreamRun, Keeper, Session, Turn
from .text import book_slug, slugify, tier_for


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class Library:
    def __init__(self, client=None, seed=None):
        if client is None:
            from google.cloud import firestore
            client = firestore.Client()
        self._c = client
        self._seed = seed  # callable(library, world_id); default set by engine to seed.apply

    # -- paths ------------------------------------------------------------
    def _world(self, wid):
        return self._c.collection("worlds").document(wid)

    def _keeper(self, wid, kid):
        return self._world(wid).collection("keepers").document(kid)

    def _book(self, wid, kid, slug):
        return self._keeper(wid, kid).collection("books").document(slug)

    # -- worlds -----------------------------------------------------------
    def ensure_world(self, wid: str) -> dict:
        snap = self._world(wid).get()
        if snap.exists:
            meta = snap.to_dict()
        else:
            meta = {"created_at": now_iso(), "seeded": self._seed is not None,
                    "dream_counter": 0, "latest_run_id": None}
            self._world(wid).set(meta)
            if self._seed:
                self._seed(self, wid)
        return meta

    def world_meta(self, wid: str) -> dict:
        snap = self._world(wid).get()
        if not snap.exists:
            raise LibraryError("WORLD_NOT_FOUND", wid)
        return snap.to_dict()

    def list_worlds(self) -> list[str]:
        return [d.id for d in self._c.collection("worlds").stream()]

    def delete_world(self, wid: str) -> None:
        for keeper in self.list_keepers(wid):
            self.delete_keeper(wid, keeper.id)
        for run in self._world(wid).collection("dreams").stream():
            run.reference.delete()
        self._world(wid).delete()

    # -- keepers ----------------------------------------------------------
    def create_keeper(self, wid: str, topic: str, *, name: str | None = None,
                      persona: str | None = None, side: str = "light",
                      archetype: str | None = None) -> Keeper:
        kid = slugify(topic)
        if self._keeper(wid, kid).get().exists:
            raise LibraryError("KEEPER_EXISTS", kid)
        cap = LIGHT_CAP if side == "light" else DARK_CAP
        if sum(1 for k in self.list_keepers(wid) if k.side == side) >= cap:
            raise LibraryError("KEEPERS_FULL", side)
        keeper = Keeper(
            id=kid, topic=topic, side=side, archetype=archetype,
            name=name or f"Keeper of {topic.strip().title()}",
            persona=persona or f"Keeper of the user's {topic.strip().lower()}. "
                               "Warm, attentive, speaks plainly and briefly.",
            palette=palette_for(kid, side), created_at=now_iso(),
        )
        self._keeper(wid, kid).set(keeper.to_doc())
        return keeper

    def get_keeper(self, wid: str, kid: str) -> Keeper:
        snap = self._keeper(wid, kid).get()
        if not snap.exists:
            raise LibraryError("KEEPER_NOT_FOUND", kid)
        return Keeper.from_doc(snap.to_dict())

    def list_keepers(self, wid: str) -> list[Keeper]:
        keepers = [Keeper.from_doc(d.to_dict())
                   for d in self._world(wid).collection("keepers").stream()]
        return sorted(keepers, key=lambda k: k.created_at)

    def update_keeper(self, wid: str, kid: str, **fields) -> None:
        self.get_keeper(wid, kid)
        self._keeper(wid, kid).set(fields, merge=True)

    def delete_keeper(self, wid: str, kid: str) -> None:
        keeper_ref = self._keeper(wid, kid)
        if not keeper_ref.get().exists:
            raise LibraryError("KEEPER_NOT_FOUND", kid)
        for book in keeper_ref.collection("books").stream():
            book.reference.delete()
        keeper_ref.collection("session").document("current").delete()
        keeper_ref.delete()

    # -- books ------------------------------------------------------------
    def write_book(self, wid: str, kid: str, *, title: str, body_md: str, date: str,
                   source: str, one_liner: str, tags: list | None = None,
                   entities: list | None = None, links: list | None = None,
                   enforce_cap: bool = True) -> Book:
        keeper = self.get_keeper(wid, kid)
        existing = {b.slug for b in self.list_books(wid, kid)}
        if enforce_cap and len(existing) >= LIBRARY_CAP:
            raise LibraryError("LIBRARY_FULL", kid)
        book = Book(
            slug=book_slug(date, title, existing), title=title, date=date,
            source=source, one_liner=one_liner, tier=tier_for(body_md),
            body_md=body_md, tags=tags or [], entities=entities or [], links=links or [],
        )
        self._book(wid, kid, book.slug).set(book.to_doc())
        self.update_keeper(wid, kid, book_count=keeper.book_count + 1, last_book_at=now_iso())
        return book

    def append_to_book(self, wid: str, kid: str, slug: str, *, note_md: str,
                       date: str) -> Book:
        """A follow-up grows the book: a dated section lands at the end and the
        tier re-derives from the new size. Metadata stays the book's own."""
        book = self.get_book(wid, kid, slug)
        body = f"{book.body_md.rstrip()}\n\n## Added {date}\n\n{note_md.strip()}"
        book.body_md, book.tier = body, tier_for(body)
        self._book(wid, kid, slug).set(book.to_doc())
        self.update_keeper(wid, kid, last_book_at=now_iso())
        return book

    NOTES_SLUG = "notes"

    def append_note(self, wid: str, kid: str, *, note_md: str, date: str,
                    tags: list | None = None, about: list | None = None) -> Book:
        """A passing remark lands as a dated entry in the keeper's one notes
        book (slug "notes"), born on its first entry and never bound away. The
        entry's `about` slugs join the book's links, its tags the book's tags;
        the book's date follows its latest entry."""
        ref = self._book(wid, kid, self.NOTES_SLUG)
        snap = ref.get()
        entry = f"## {date}\n\n{note_md.strip()}"
        if snap.exists:
            book = Book.from_doc(snap.to_dict())
            book.body_md = f"{book.body_md.rstrip()}\n\n{entry}"
            counted = {}
        else:
            keeper = self.get_keeper(wid, kid)
            if len(self.list_books(wid, kid)) >= LIBRARY_CAP:
                raise LibraryError("LIBRARY_FULL", kid)
            book = Book(slug=self.NOTES_SLUG, title="Loose notes", date=date, source="notes",
                        one_liner="Passing remarks, reactions and asides, each about "
                                  "something this shelf keeps.",
                        tier="small", body_md=entry)
            counted = {"book_count": keeper.book_count + 1}
        book.date = date
        book.tags = sorted({*book.tags, *(tags or [])})[:8]
        book.links = sorted({*book.links, *(about or [])})
        book.tier = tier_for(book.body_md)
        ref.set(book.to_doc())
        self.update_keeper(wid, kid, last_book_at=now_iso(), **counted)
        return book

    def get_book(self, wid: str, kid: str, slug: str) -> Book:
        snap = self._book(wid, kid, slug).get()
        if not snap.exists:
            raise LibraryError("BOOK_NOT_FOUND", slug)
        return Book.from_doc(snap.to_dict())

    def list_books(self, wid: str, kid: str) -> list[Book]:
        books = [Book.from_doc(d.to_dict())
                 for d in self._keeper(wid, kid).collection("books").stream()]
        return sorted(books, key=lambda b: (b.date, b.slug), reverse=True)

    def delete_book(self, wid: str, kid: str, slug: str) -> None:
        keeper = self.get_keeper(wid, kid)
        ref = self._book(wid, kid, slug)
        if not ref.get().exists:
            raise LibraryError("BOOK_NOT_FOUND", slug)
        ref.delete()
        self.update_keeper(wid, kid, book_count=max(0, keeper.book_count - 1))

    def index_rows(self, wid: str, kid: str) -> list[dict]:
        return [b.summary() for b in self.list_books(wid, kid)]

    MERGEABLE_SOURCES = ("told", "sleep")

    def make_room(self, wid: str, kid: str, incoming: int = 1) -> tuple[list[Book], bool]:
        """Frees bookcase slots by binding the two oldest mergeable books into one
        digest per merge, until `incoming` new books fit plus one spare slot.
        Returns (digests_written, fits). Nothing a merged book held is lost."""
        digests: list[Book] = []
        while True:
            books = self.list_books(wid, kid)
            if len(books) <= LIBRARY_CAP - incoming - 1:
                return digests, True
            olds = sorted((b for b in books if b.source in self.MERGEABLE_SOURCES),
                          key=lambda b: (b.date, b.slug))
            if len(olds) < 2:
                return digests, len(books) <= LIBRARY_CAP - incoming
            a, b = olds[0], olds[1]
            body = (f"## {a.title} ({a.date}, was {a.slug})\n\n{a.body_md}\n\n"
                    f"## {b.title} ({b.date}, was {b.slug})\n\n{b.body_md}")
            self.delete_book(wid, kid, a.slug)
            self.delete_book(wid, kid, b.slug)
            digests.append(self.write_book(
                wid, kid, title=f"Bound: {a.title} + {b.title}"[:80], body_md=body,
                date=a.date, source="sleep",
                one_liner=f"Two older books bound together: {a.title}; {b.title}."[:140],
                tags=sorted({*a.tags, *b.tags})[:6],
                entities=sorted({*a.entities, *b.entities})[:8],
                links=sorted({a.slug, b.slug, *a.links, *b.links}),
                enforce_cap=False))

    # -- sessions and meters ------------------------------------------------
    def _session_ref(self, wid, kid):
        return self._keeper(wid, kid).collection("session").document("current")

    def session_read(self, wid: str, kid: str) -> Session:
        snap = self._session_ref(wid, kid).get()
        return Session.from_doc(snap.to_dict() if snap.exists else None)

    def session_append(self, wid: str, kid: str, turns: list[Turn],
                       constraints: list[str] | None = None) -> Session:
        session = self.session_read(wid, kid)
        session.turns.extend(turns)
        for c in constraints or []:
            if c not in session.blocks["constraints"]:
                session.blocks["constraints"].append(c)
        self._session_ref(wid, kid).set(session.to_doc())
        return session

    def session_replace(self, wid: str, kid: str, session: Session) -> None:
        self._session_ref(wid, kid).set(session.to_doc())

    def meter_add(self, wid: str, kid: str, tokens: int) -> int:
        keeper = self.get_keeper(wid, kid)
        total = keeper.tokens_used + max(0, tokens)
        self.update_keeper(wid, kid, tokens_used=total)
        return total

    def meter_reset(self, wid: str, kid: str, tokens: int) -> None:
        self.update_keeper(wid, kid, tokens_used=max(0, tokens))

    # -- world travel -------------------------------------------------------
    def export_world(self, wid: str) -> dict:
        from . import travel
        return travel.export_world(self, wid)

    def import_world(self, wid: str, data) -> dict:
        from . import travel
        return travel.import_world(self, wid, data)

    # -- dream runs ---------------------------------------------------------
    def list_dreams(self, wid: str) -> list[DreamRun]:
        runs = [DreamRun.from_doc(d.to_dict())
                for d in self._world(wid).collection("dreams").stream()]
        return sorted(runs, key=lambda r: r.run_id)

    def dream_start(self, wid: str, reason: str, status: str = "running") -> DreamRun:
        meta = self.world_meta(wid)
        n = meta.get("dream_counter", 0) + 1
        run = DreamRun(run_id=f"run-{n:04d}", status=status, reason=reason,
                       started_at=now_iso())
        self._world(wid).collection("dreams").document(run.run_id).set(run.to_doc())
        self._world(wid).set({"dream_counter": n, "latest_run_id": run.run_id}, merge=True)
        return run

    def dream_update(self, wid: str, run_id: str, **fields) -> None:
        self._world(wid).collection("dreams").document(run_id).set(fields, merge=True)

    def dream_get(self, wid: str, run_id: str) -> DreamRun:
        snap = self._world(wid).collection("dreams").document(run_id).get()
        if not snap.exists:
            raise LibraryError("DREAM_NOT_FOUND", run_id)
        return DreamRun.from_doc(snap.to_dict())

    def dream_latest(self, wid: str) -> DreamRun:
        run_id = self.world_meta(wid).get("latest_run_id")
        if not run_id:
            raise LibraryError("DREAM_NOT_FOUND", "no run yet")
        return self.dream_get(wid, run_id)
