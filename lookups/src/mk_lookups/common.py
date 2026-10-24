"""Pieces shared by the lookup modules."""

TEXT_CAP = 12000  # transcript text cap, sized for a model tool result


def clean(value) -> str:
    """The incoming argument as a stripped string; None becomes ''."""
    return str(value or "").strip()
