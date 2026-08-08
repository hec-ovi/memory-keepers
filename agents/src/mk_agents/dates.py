"""Relative date resolution, purely by rules, to bias retrieval:
"yesterday", "3 days ago", "last week", "in june", ISO dates."""
import re
from datetime import date, timedelta

MONTHS = ("january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december")


def resolve(text: str, today: date) -> tuple[str, str, str] | None:
    """Returns (start_iso, end_iso, matched_phrase) or None."""
    t = text.lower()

    iso = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", t)
    if iso:
        return iso.group(1), iso.group(1), iso.group(1)
    if "yesterday" in t:
        d = today - timedelta(days=1)
        return d.isoformat(), d.isoformat(), "yesterday"
    if "today" in t:
        return today.isoformat(), today.isoformat(), "today"
    ago = re.search(r"\b(\d{1,2}) days? ago\b", t)
    if ago:
        d = today - timedelta(days=int(ago.group(1)))
        return d.isoformat(), d.isoformat(), ago.group(0)
    if "last week" in t:
        start = today - timedelta(days=today.weekday() + 7)
        return start.isoformat(), (start + timedelta(days=6)).isoformat(), "last week"
    if "this week" in t:
        start = today - timedelta(days=today.weekday())
        return start.isoformat(), today.isoformat(), "this week"
    if "last month" in t:
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        return last_prev.replace(day=1).isoformat(), last_prev.isoformat(), "last month"
    for i, month in enumerate(MONTHS, start=1):
        if re.search(rf"\b(?:in|last|during) {month}\b", t):
            year = today.year if i <= today.month else today.year - 1
            start = date(year, i, 1)
            end = (date(year + 1, 1, 1) if i == 12 else date(year, i + 1, 1)) - timedelta(days=1)
            return start.isoformat(), end.isoformat(), month
    return None
