"""Relative date resolution, purely by rules. resolve_phrase turns one phrase
("tomorrow", "in two weeks", "next friday", "3 days ago", "march 3") into the
calendar day it means; resolve finds a window in free text to bias retrieval."""
import re
from datetime import date, timedelta

MONTHS = ("january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december")
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
NUMBER_WORDS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
                "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
                "twelve": 12, "couple": 2, "few": 3}
UNIT_DAYS = {"day": 1, "week": 7, "fortnight": 14}
WEEKDAY_ALT = "|".join(WEEKDAYS)
PHRASE_RE = re.compile(
    r"\b(day after tomorrow|tomorrow|yesterday|tonight|"
    r"in (?:\w+) (?:days?|weeks?|fortnights?|months?|years?)|"
    r"(?:\w+) (?:days?|weeks?|months?|years?) ago|"
    rf"(?:next|this|on|coming) (?:{WEEKDAY_ALT}|week|weekend|month|year)|"
    rf"end of (?:the|this) month|{WEEKDAY_ALT})\b")


def _count(word: str) -> int | None:
    if word.isdigit():
        return int(word)
    return NUMBER_WORDS.get(word)


def _add_months(d: date, n: int) -> date:
    month0 = d.month - 1 + n
    year, month = d.year + month0 // 12, month0 % 12 + 1
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(d.day, last))


def resolve_phrase(phrase: str, today: date) -> date | None:
    """One relative phrase to its calendar day, or None when not understood.
    Bare, "this" and "on" weekdays mean the coming one (today counts);
    "next <weekday>" is the one after today, never today."""
    t = " ".join(phrase.strip().lower().split())
    iso = re.fullmatch(r"(\d{4}-\d{2}-\d{2})", t)
    if iso:
        return date.fromisoformat(iso.group(1))
    if t in ("today", "now", "tonight"):
        return today
    if t == "tomorrow":
        return today + timedelta(days=1)
    if t == "day after tomorrow":
        return today + timedelta(days=2)
    if t == "yesterday":
        return today - timedelta(days=1)
    m = re.fullmatch(r"in (\w+) (day|week|fortnight|month|year)s?", t)
    if m and _count(m.group(1)) is not None:
        n, unit = _count(m.group(1)), m.group(2)
        if unit in UNIT_DAYS:
            return today + timedelta(days=n * UNIT_DAYS[unit])
        return _add_months(today, n * (12 if unit == "year" else 1))
    m = re.fullmatch(r"(\w+) (day|week|month|year)s? ago", t)
    if m and _count(m.group(1)) is not None:
        n, unit = _count(m.group(1)), m.group(2)
        if unit in UNIT_DAYS:
            return today - timedelta(days=n * UNIT_DAYS[unit])
        return _add_months(today, -n * (12 if unit == "year" else 1))
    m = re.fullmatch(rf"(?:(next|this|on|coming) )?({WEEKDAY_ALT})", t)
    if m:
        delta = (WEEKDAYS.index(m.group(2)) - today.weekday()) % 7
        if m.group(1) == "next" and delta == 0:
            delta = 7
        return today + timedelta(days=delta)
    m = re.fullmatch(r"(next|this) (week|weekend|month|year)", t)
    if m:
        ahead = m.group(1) == "next"
        unit = m.group(2)
        if unit == "week":
            return today + timedelta(days=7 if ahead else 0)
        if unit == "weekend":
            delta = (5 - today.weekday()) % 7
            return today + timedelta(days=delta + (7 if ahead else 0))
        return _add_months(today, (12 if unit == "year" else 1) if ahead else 0)
    if t in ("end of the month", "end of this month"):
        return _add_months(today.replace(day=1), 1) - timedelta(days=1)
    m = re.fullmatch(rf"(?:(\d{{1,2}})(?:st|nd|rd|th)? (?:of )?)?({'|'.join(MONTHS)})(?: (\d{{1,2}})(?:st|nd|rd|th)?)?(?:,? (\d{{4}}))?", t)
    if m and (m.group(1) or m.group(3)):
        day, month = int(m.group(1) or m.group(3)), MONTHS.index(m.group(2)) + 1
        year = int(m.group(4)) if m.group(4) else today.year
        try:
            d = date(year, month, day)
        except ValueError:
            return None
        if not m.group(4) and d < today:
            d = date(year + 1, month, day)
        return d
    return None


def resolve(text: str, today: date) -> tuple[str, str, str] | None:
    """Returns (start_iso, end_iso, matched_phrase) or None."""
    t = text.lower()

    iso = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", t)
    if iso:
        return iso.group(1), iso.group(1), iso.group(1)
    if "next week" in t:
        start = today + timedelta(days=7 - today.weekday())
        return start.isoformat(), (start + timedelta(days=6)).isoformat(), "next week"
    phrase = PHRASE_RE.search(t)
    if phrase and phrase.group(1) not in ("yesterday", "tonight"):
        day = resolve_phrase(phrase.group(1), today)
        if day and day >= today:
            return day.isoformat(), day.isoformat(), phrase.group(1)
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
