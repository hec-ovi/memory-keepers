"""Prompt loading: every instruction lives in prompts/*.md, filled via $tokens."""
from pathlib import Path
from string import Template

_DIR = Path(__file__).parent / "prompts"
_CACHE: dict[str, Template] = {}


def prompt(name: str, **values) -> str:
    if name not in _CACHE:
        _CACHE[name] = Template((_DIR / f"{name}.md").read_text())
    return _CACHE[name].substitute(**values)


def session_block(session, tail: int = 6) -> str:
    lines = []
    for key, label in (("constraints", "Constraints"), ("recent_topics", "Recent topics")):
        items = session.blocks.get(key, [])
        if items:
            lines.append(f"{label}:")
            lines.extend(f"- {item}" for item in items)
    turns = session.turns[-tail:]
    if turns:
        lines.append("Last turns:")
        lines.extend(f"- [{t.t}] {t.role}: {t.text}" for t in turns)
    return "\n".join(lines) or "(first conversation)"


def index_block(rows: list[dict]) -> str:
    if not rows:
        return "(the shelf is empty)"
    return "\n".join(f"{r['slug']} | {r['date']} | {r['one_liner']}" for r in rows)
