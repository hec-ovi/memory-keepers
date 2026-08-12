"""Song facts through MusicBrainz (core data CC0, safe to store in books).
Its default ranking puts live bootlegs first, so results are filtered to
official releases and the earliest release date wins."""
import httpx

from .common import clean

MUSICBRAINZ = "https://musicbrainz.org/ws/2/recording"
NOT_THE_SONG = ("karaoke", "tribute", "cover version", "made famous")
NO_YEAR = 9999  # undated releases sort last


def _year(date: str) -> int | None:
    return int(date[:4]) if date and date[:4].isdigit() else None


class SongFacts:
    def __init__(self, client: httpx.Client):
        self._client = client

    def facts(self, title: str, artist: str = "") -> dict:
        title, artist = clean(title), clean(artist)
        if not title:
            return {"ok": False, "reason": "no_title"}
        query = (f'recording:"{title}"' + (f" AND artist:{artist}" if artist else "")
                 + " AND status:official AND video:false")
        try:
            res = self._client.get(MUSICBRAINZ, params={"query": query, "fmt": "json",
                                                        "limit": 25})
            recordings = res.json().get("recordings", []) if res.status_code == 200 else []
        except Exception:
            return {"ok": False, "reason": "unavailable"}
        best = None
        for rec in recordings:
            official = [r for r in rec.get("releases", [])
                        if r.get("status") == "Official"
                        and not any(m in (r.get("title") or "").lower()
                                    for m in NOT_THE_SONG)]
            if not official:
                continue
            year = _year(rec.get("first-release-date", ""))
            if best is None or (year or NO_YEAR) < (best[0] or NO_YEAR):
                best = (year, rec, official[0])
        if not best:
            return {"ok": False, "reason": "not_found"}
        year, rec, release = best
        credit = ", ".join(c.get("name", "") for c in rec.get("artist-credit", [])
                           if isinstance(c, dict) and c.get("name"))
        return {"ok": True, "source": "musicbrainz", "title": rec.get("title") or title,
                "artist": credit or artist, "year": str(year or ""),
                "album": release.get("title") or ""}
