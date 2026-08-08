"""Capacity and session limits, defined once for every box."""

LIGHT_CAP = 16          # plots on the light side
DARK_CAP = 8            # plots on the dark side
LIBRARY_CAP = 24        # one bookcase, 24 slots

SESSION_TOKEN_BUDGET_DEFAULT = 12_000
UNRESTED_THRESHOLD = 0.70
NEEDS_SLEEP_THRESHOLD = 0.85

ARCHETYPES = ("desire", "fear", "ambition", "obsession")
BOOK_SOURCES = ("told", "dream", "seed", "sleep")


def session_status(tokens_used: int, budget: int) -> str:
    ratio = tokens_used / budget if budget else 1.0
    if ratio >= NEEDS_SLEEP_THRESHOLD:
        return "needs_sleep"
    if ratio >= UNRESTED_THRESHOLD:
        return "unrested"
    return "rested"
