"""YouTube transcript fetch through youtube-transcript-api (keyless).

YouTube blocks most cloud-provider IP ranges, so this works from residential
IPs (the local tier, the demo) and degrades to {"ok": False} on Cloud Run;
the keeper writes her book without the transcript."""
import re

TEXT_CAP = 12000
_ID_PATTERNS = (
    re.compile(r"(?:youtu\.be/|shorts/|watch\?v=|[?&]v=|embed/)([A-Za-z0-9_-]{11})"),
    re.compile(r"^([A-Za-z0-9_-]{11})$"),
)


def video_id(url_or_id: str) -> str | None:
    text = (url_or_id or "").strip()
    for pattern in _ID_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(1)
    return None


def _default_fetch(vid: str) -> str:
    from youtube_transcript_api import YouTubeTranscriptApi

    fetched = YouTubeTranscriptApi().fetch(vid)
    return " ".join(snippet.text.strip() for snippet in fetched if snippet.text)


class TranscriptLookup:
    def __init__(self, fetch=None):
        self._fetch = fetch or _default_fetch

    def transcript(self, url_or_id: str) -> dict:
        vid = video_id(url_or_id)
        if not vid:
            return {"ok": False, "reason": "not_a_youtube_url"}
        try:
            text = self._fetch(vid).strip()
        except Exception:
            return {"ok": False, "reason": "unavailable"}
        if not text:
            return {"ok": False, "reason": "no_transcript"}
        return {"ok": True, "video_id": vid, "truncated": len(text) > TEXT_CAP,
                "text": text[:TEXT_CAP]}
