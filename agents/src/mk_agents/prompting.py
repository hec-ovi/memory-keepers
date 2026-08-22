"""Prompt loading: every instruction lives in prompts/*.md, filled via $tokens.
Read on every call, so an edited prompt is live on the next message."""
from pathlib import Path
from string import Template

_DIR = Path(__file__).parent / "prompts"
TURN_CHARS = 280  # a turn in the prompt is a reminder, not the whole message


def prompt(name: str, **values) -> str:
    return Template((_DIR / f"{name}.md").read_text()).substitute(**values)


def session_block(session) -> str:
    lines = []
    for key, label in (("constraints", "Constraints"), ("recent_topics", "Recent topics")):
        items = session.blocks.get(key, [])
        if items:
            lines.append(f"{label}:")
            lines.extend(f"- {item}" for item in items)
    turns = session.turns[-6:]
    if turns:
        lines.append("Last turns:")
        lines.extend(f"- [{t.t}] {t.role}: {clip(t.text)}" for t in turns)
    return "\n".join(lines) or "(first conversation)"


def clip(text: str, cap: int = TURN_CHARS) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= cap else text[: cap - 3].rsplit(" ", 1)[0] + "..."


def index_block(rows: list[dict]) -> str:
    if not rows:
        return "(the shelf is empty)"
    return "\n".join(f"{r['slug']} | {r['date']} | {r['one_liner']}" for r in rows)


def index_block_across(rows: list[dict]) -> str:
    """Rows from many shelves: each carries keeper_id, shown as keeper/slug."""
    if not rows:
        return "(the village has no books yet)"
    return "\n".join(f"{r['keeper_id']}/{r['slug']} | {r['date']} | {r['one_liner']}"
                      for r in rows)
