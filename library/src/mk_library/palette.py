"""Deterministic keeper palettes: one hue pair per topic."""
import colorsys
import hashlib

NAMED = {
    "dreams": {"primary": "#7c6cf0", "accent": "#2e2560"},
    "meetings": {"primary": "#3bbfad", "accent": "#14453f"},
    "music": {"primary": "#f0a53c", "accent": "#5c3a10"},
}


def palette_for(topic: str, side: str = "light") -> dict:
    if topic in NAMED and side == "light":
        return dict(NAMED[topic])
    h = int.from_bytes(hashlib.sha256(topic.encode()).digest()[:4], "big") / 2**32
    h = 0.02 + h * 0.78  # hues stay between red and violet; the pink band never appears
    sat, light = (0.55, 0.62) if side == "light" else (0.45, 0.38)
    r, g, b = colorsys.hls_to_rgb(h, light, sat)
    ra, ga, ba = colorsys.hls_to_rgb(h, light * 0.45, sat)
    to_hex = lambda r, g, b: "#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255))
    return {"primary": to_hex(r, g, b), "accent": to_hex(ra, ga, ba)}
