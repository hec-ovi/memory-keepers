"""Slugs and book tiers, pure functions."""
import re

TIER_BOUNDS = (400, 1200, 3000)  # body chars: small < 400 <= medium < 1200 <= big < 3000 <= large


def slugify(text: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:max_len].rstrip("-") or "untitled"


def book_slug(date: str, title: str, taken: set[str]) -> str:
    base = f"{date}-{slugify(title)}"
    slug, n = base, 1
    while slug in taken:
        n += 1
        slug = f"{base}-{n}"
    return slug


def tier_for(body_md: str) -> str:
    n = len(body_md)
    if n < TIER_BOUNDS[0]:
        return "small"
    if n < TIER_BOUNDS[1]:
        return "medium"
    if n < TIER_BOUNDS[2]:
        return "big"
    return "large"
