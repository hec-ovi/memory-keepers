"""Deterministic text rules: JSON salvage, extraction fallbacks and constraint
harvesting. The game must work even if the model returns garbage."""
import json
import re

ENTITY_RE = re.compile(r"\b([A-Z][a-z]+(?: [A-Z][a-z]+)+)\b")
CONSTRAINT_RE = re.compile(
    r"\b(always|never|do not|don't|must|remember to|promise)\b", re.IGNORECASE)
# Keep identical to mk_models.fake_llm.STOPWORDS (models cannot import from agents).
STOPWORDS = {"the", "and", "that", "with", "about", "this", "from", "have", "what",
             "when", "where", "there", "were", "will", "your", "into", "just", "like"}


def parse_json(text: str) -> dict | None:
    """Lenient: accepts the object anywhere in the text (code fences included)."""
    start = text.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        data = json.loads(text[start:i + 1])
                        return data if isinstance(data, dict) else None
                    except ValueError:
                        break
        start = text.find("{", start + 1)
    return None


def first_sentence(text: str, cap: int) -> str:
    sentence = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0].strip().rstrip(".!?")
    return sentence[:cap].strip()


def extract_book_fields(text: str) -> dict:
    words = [w for w in re.findall(r"[a-z]{4,}", text.lower()) if w not in STOPWORDS]
    return {
        "title": first_sentence(text, 60) or "A new memory",
        "tags": sorted(set(words), key=words.index)[:4],
        "entities": list(dict.fromkeys(ENTITY_RE.findall(text)))[:6],
        "one_liner": (first_sentence(text, 140) or "A memory") + ".",
    }


def harvest_constraints(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s", text)
            if s.strip() and CONSTRAINT_RE.search(s)]


def dated_citation(row: dict) -> str:
    return f"On {row['date']} you told me: {row['one_liner']}"
