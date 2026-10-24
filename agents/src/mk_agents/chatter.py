"""Ambient speech bubbles, literally from books. After each consolidation the
agents api stores per-keeper lines drawn from her shelf (one liners and
titles); a seeded rotation picks one per visit. No model, no writes here; a
keeper without lines stays silent."""
import hashlib
import time

BUCKET_SECONDS = 47  # bubbles rotate roughly every visit, not every frame
LINE_CAP = 89  # contract: < 90 chars
MAX_LINES = 24
SILENT_SOURCES = ("sleep", "notes")  # bookkeeping books say nothing a bubble should


def clamp(text: str) -> str:
    line = " ".join(str(text or "").split())
    if len(line) <= LINE_CAP:
        return line
    return line[: LINE_CAP - 3].rsplit(" ", 1)[0] + "..."


def lines_from_books(books) -> list[str]:
    """One liners and titles of her real books, in shelf order, deduplicated."""
    lines: list[str] = []
    for book in books:
        if book.source in SILENT_SOURCES:
            continue
        for text in (book.one_liner, f"Ask me about {book.title}."):
            line = clamp(text)
            if line and line not in lines:
                lines.append(line)
    return lines[:MAX_LINES]


def pick(lines: list[str], keeper_id: str, now: float | None = None) -> str | None:
    if not lines:
        return None
    seed = int.from_bytes(hashlib.sha256(keeper_id.encode()).digest()[:4], "big")
    order = sorted(range(len(lines)), key=lambda i: hashlib.sha256(
        f"{seed}:{i}".encode()).digest())
    bucket = int((now if now is not None else time.time()) // BUCKET_SECONDS)
    return lines[order[(seed + bucket) % len(lines)]]
