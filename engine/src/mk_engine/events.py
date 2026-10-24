"""Dream dispatch: every run is a background task on the engine's loop, and a
nightly timer dreams every world at the hour the env DREAM_AT names. Both
paths end in dreaming.run_dream for the same world."""
import asyncio
import logging
from datetime import datetime, time, timedelta

from mk_dreaming import run_dream

log = logging.getLogger(__name__)


def parse_clock(text: str) -> time | None:
    """"HH:MM" (24 h, local time) -> time; empty -> None (no nightly run)."""
    text = text.strip()
    if not text:
        return None
    hours, minutes = text.split(":")
    return time(int(hours), int(minutes))


def seconds_until(at: time, now: datetime) -> float:
    """Seconds from now to the next `at`; a time already past today means tomorrow."""
    target = datetime.combine(now.date(), at)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


class DreamDispatcher:
    def __init__(self, library, agents_api):
        self.library = library
        self.agents_api = agents_api
        self._tasks: set = set()  # keep runs alive until they settle

    def dispatch(self, world: str, reason: str, run_id: str | None = None) -> None:
        self._spawn(run_dream(self.library, self.agents_api, world, reason, run_id))

    async def nightly(self) -> int:
        """Dreams every world, one after another (one model serves them all).
        Returns how many worlds dreamed."""
        worlds = self.library.list_worlds()
        for wid in worlds:
            await run_dream(self.library, self.agents_api, wid, "nightly")
        return len(worlds)

    async def nightly_loop(self, at: time) -> None:
        while True:
            await asyncio.sleep(seconds_until(at, datetime.now()))
            try:
                await self.nightly()
            except Exception:
                log.exception("nightly dream sweep failed")

    def _spawn(self, coro) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
