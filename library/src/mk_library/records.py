"""Record types stored in Firestore. Docs are plain dicts; these classes are the shapes."""
from dataclasses import asdict, dataclass, field
from math import isqrt

from .limits import session_status


@dataclass
class Keeper:
    id: str
    name: str
    topic: str
    side: str                      # "light" | "dark"
    persona: str
    palette: dict
    created_at: str
    archetype: str | None = None   # dark only
    book_count: int = 0
    last_book_at: str | None = None
    tokens_used: int = 0
    sleep_job: dict | None = None  # {job_id, status, started_at, finished_at, books_written, error}

    def to_doc(self) -> dict:
        return asdict(self)

    @classmethod
    def from_doc(cls, doc: dict) -> "Keeper":
        return cls(**{k: doc.get(k) for k in cls.__dataclass_fields__})

    @property
    def level(self) -> int:
        return 1 + isqrt(self.book_count)

    def books_to_next(self) -> int:
        return self.level**2 - self.book_count

    def payload(self, budget: int) -> dict:
        return {
            "id": self.id, "name": self.name, "topic": self.topic, "side": self.side,
            "archetype": self.archetype, "persona": self.persona, "palette": self.palette,
            "created_at": self.created_at, "book_count": self.book_count,
            "last_book_at": self.last_book_at, "level": self.level,
            "books_to_next": self.books_to_next(),
            "session": {
                "tokens_used": self.tokens_used, "budget": budget,
                "status": session_status(self.tokens_used, budget),
            },
            "sleeping": bool(self.sleep_job and self.sleep_job.get("status") == "running"),
        }


@dataclass
class Book:
    slug: str
    title: str
    date: str                      # YYYY-MM-DD
    source: str                    # told | dream | seed | sleep
    one_liner: str
    tier: str
    body_md: str
    tags: list = field(default_factory=list)
    entities: list = field(default_factory=list)
    links: list = field(default_factory=list)

    def to_doc(self) -> dict:
        return asdict(self)

    @classmethod
    def from_doc(cls, doc: dict) -> "Book":
        return cls(**{k: doc.get(k) for k in cls.__dataclass_fields__})

    def summary(self) -> dict:
        return {k: getattr(self, k) for k in
                ("slug", "title", "date", "tags", "entities", "source", "one_liner", "tier")}

    def payload(self) -> dict:
        return self.summary() | {"body_md": self.body_md, "links": self.links}


@dataclass
class Turn:
    t: str                         # ISO datetime UTC
    role: str                      # "user" | "keeper"
    text: str


BLOCK_KEYS = ("constraints", "recent_topics")


@dataclass
class Session:
    blocks: dict = field(default_factory=lambda: {k: [] for k in BLOCK_KEYS})
    turns: list = field(default_factory=list)   # list[Turn]
    sleep_count: int = 0

    def to_doc(self) -> dict:
        return {"blocks": self.blocks, "turns": [asdict(t) for t in self.turns],
                "sleep_count": self.sleep_count}

    @classmethod
    def from_doc(cls, doc: dict | None) -> "Session":
        if not doc:
            return cls()
        blocks = {k: list(doc.get("blocks", {}).get(k, [])) for k in BLOCK_KEYS}
        turns = [Turn(**t) for t in doc.get("turns", [])]
        return cls(blocks=blocks, turns=turns, sleep_count=doc.get("sleep_count", 0))


@dataclass
class DreamRun:
    run_id: str
    status: str                    # running | done | failed
    reason: str
    started_at: str
    finished_at: str | None = None
    narrative: str = ""
    graph: dict = field(default_factory=lambda: {"nodes": [], "edges": []})
    created_keepers: list = field(default_factory=list)
    created_books: list = field(default_factory=list)
    skipped_themes: list = field(default_factory=list)
    error: str | None = None

    def to_doc(self) -> dict:
        return asdict(self)

    @classmethod
    def from_doc(cls, doc: dict) -> "DreamRun":
        return cls(**{k: doc.get(k) for k in cls.__dataclass_fields__})
