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

    # -- dream runs ---------------------------------------------------------
    def dream_start(self, wid: str, reason: str) -> DreamRun:
        meta = self.world_meta(wid)
        n = meta.get("dream_counter", 0) + 1
        run = DreamRun(run_id=f"run-{n:04d}", status="running", reason=reason,
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
