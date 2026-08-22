"""Sleep: the per-keeper compaction. Deterministic, always succeeds.
Constraints are copied forward verbatim; dropped turns that are not already
on the shelf (a tell that wrote or grew a book is) stay retrievable as a
sleep book; the meter resets to the compacted session's size."""
import asyncio
import json
import logging
import uuid
from datetime import date

from mk_library import Library
from mk_library.store import now_iso

log = logging.getLogger(__name__)
VERBATIM_TAIL_TURNS = 3
RECENT_TOPICS_WINDOW = 4
CHARS_PER_TOKEN = 4  # the meter's rough estimate after compaction
_JOBS: set[asyncio.Task] = set()  # keep sleep jobs referenced until they settle


def unshelved_turns(turns: list) -> list:
    """The turns a sleep book must keep: a user turn whose tell already wrote
    or grew a book, and the keeper reply that followed it, are on the shelf."""
    kept, skip_reply = [], False
    for turn in turns:
        if turn.role == "user":
            skip_reply = bool(getattr(turn, "book", None))
            if not skip_reply:
                kept.append(turn)
        elif not skip_reply:
            kept.append(turn)
    return kept


def perform_sleep(library: Library, world: str, kid: str) -> list[dict]:
    session = library.session_read(world, kid)
    dropped = session.turns[:-VERBATIM_TAIL_TURNS]
    unshelved = unshelved_turns(dropped)
    books_written = []

    if unshelved:
        digests, fits = library.make_room(world, kid, incoming=1)
        books_written.extend(d.summary() for d in digests)
        if fits:
            today = date.today().isoformat()
            body = "\n".join(f"- [{t.t}] {t.role}: {t.text}" for t in unshelved)
            book = library.write_book(
                world, kid, title=f"Sleep notes, {today}", body_md=body, date=today,
                source="sleep",
                one_liner=f"What this shelf heard before sleeping on {today}.",
                tags=["sleep"], enforce_cap=False)
            books_written.append(book.summary())

    user_texts = [t.text for t in dropped if t.role == "user"]
    for text in user_texts[-RECENT_TOPICS_WINDOW:]:
        if text not in session.blocks["recent_topics"]:
            session.blocks["recent_topics"] = (
                session.blocks["recent_topics"] + [text])[-RECENT_TOPICS_WINDOW:]
    session.turns = session.turns[-VERBATIM_TAIL_TURNS:]
    session.sleep_count += 1
    library.session_replace(world, kid, session)
    library.meter_reset(world, kid, len(json.dumps(session.to_doc())) // CHARS_PER_TOKEN)
    return books_written


def start_sleep_job(library: Library, world: str, kid: str) -> str:
    job_id = f"sleep-{uuid.uuid4().hex[:8]}"
    library.update_keeper(world, kid, sleep_job={
        "job_id": job_id, "status": "running", "started_at": now_iso(),
        "finished_at": None, "books_written": [], "error": None})

    async def run():
        try:
            books = await asyncio.to_thread(perform_sleep, library, world, kid)
            library.update_keeper(world, kid, sleep_job={
                "job_id": job_id, "status": "done", "finished_at": now_iso(),
                "books_written": books, "error": None})
        except Exception as e:
            log.exception("sleep job failed")
            library.update_keeper(world, kid, sleep_job={
                "job_id": job_id, "status": "failed", "finished_at": now_iso(),
                "books_written": [], "error": str(e)})

    task = asyncio.get_running_loop().create_task(run())
    _JOBS.add(task)
    task.add_done_callback(_JOBS.discard)
    return job_id
