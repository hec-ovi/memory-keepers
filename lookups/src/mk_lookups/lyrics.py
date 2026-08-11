"""Song lyrics: LRCLIB first (keyless, full lyrics), lyrics.ovh as fallback.

LRCLIB silently drops connections for disfavored User-Agent strings, so the
shared client carries the project's own UA and any failure falls through."""
import httpx

LRCLIB_SEARCH = "https://lrclib.net/api/search"
LYRICS_OVH = "https://api.lyrics.ovh/v1/{artist}/{title}"
LYRICS_CAP = 8000


class LyricsLookup:
    def __init__(self, client: httpx.Client):
        self._client = client

    def lyrics(self, title: str, artist: str = "") -> dict:
        title, artist = (title or "").strip(), (artist or "").strip()
        if not title:
            return {"ok": False, "reason": "no_title"}
        found = self._lrclib(title, artist) or self._ovh(title, artist)
        if not found:
            return {"ok": False, "reason": "not_found"}
        return {"ok": True, **found}

    def _lrclib(self, title: str, artist: str) -> dict | None:
        params = {"track_name": title}
        if artist:
            params["artist_name"] = artist
        try:
            res = self._client.get(LRCLIB_SEARCH, params=params)
            hits = res.json() if res.status_code == 200 else []
        except Exception:
            return None
        for hit in hits if isinstance(hits, list) else []:
            text = (hit.get("plainLyrics") or "").strip()
            if text:
                return {"source": "lrclib", "title": hit.get("trackName") or title,
                        "artist": hit.get("artistName") or artist,
                        "lyrics": text[:LYRICS_CAP]}
        return None

    def _ovh(self, title: str, artist: str) -> dict | None:
        if not artist:
            return None
        try:
            res = self._client.get(LYRICS_OVH.format(artist=artist, title=title))
            text = (res.json().get("lyrics") or "").strip() if res.status_code == 200 else ""
        except Exception:
            return None
        if not text:
            return None
        return {"source": "lyrics.ovh", "title": title, "artist": artist,
                "lyrics": text[:LYRICS_CAP]}
