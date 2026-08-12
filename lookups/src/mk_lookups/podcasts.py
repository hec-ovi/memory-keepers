"""Podcast transcripts: iTunes Search (keyless) resolves the show to its RSS
feed; the feed's <podcast:transcript> tag (VTT) carries the transcript when
the publisher ships one. No transcript is a first-class answer, not an error."""
import re
import xml.etree.ElementTree as ET

import httpx

from .common import TEXT_CAP, clean

ITUNES = "https://itunes.apple.com/search"
CUE_RE = re.compile(r"^\d\d:\d\d.*-->.*$|^WEBVTT.*$|^\d+$|^NOTE\b.*$", re.M)


def strip_vtt(vtt: str) -> str:
    lines = [ln.strip() for ln in CUE_RE.sub("", vtt).splitlines()]
    seen, out = None, []
    for line in lines:
        if line and line != seen:
            out.append(line)
            seen = line
    return " ".join(out)


class PodcastTranscript:
    def __init__(self, client: httpx.Client):
        self._client = client

    def transcript(self, show: str, episode: str = "") -> dict:
        show, episode = clean(show), clean(episode)
        if not show:
            return {"ok": False, "reason": "no_title"}
        try:
            feed_url, show_name = self._feed_url(show)
            if not feed_url:
                return {"ok": False, "reason": "not_found"}
            found = self._episode(feed_url, episode)
            if not found:
                return {"ok": False, "reason": "not_found"}
            ep_title, transcript_url = found
            if not transcript_url:
                return {"ok": False, "reason": "no_transcript", "show": show_name,
                        "episode": ep_title}
            text = strip_vtt(self._client.get(transcript_url).text)
        except Exception:
            return {"ok": False, "reason": "unavailable"}
        if not text:
            return {"ok": False, "reason": "no_transcript", "show": show_name,
                    "episode": ep_title}
        return {"ok": True, "source": "rss", "show": show_name, "episode": ep_title,
                "truncated": len(text) > TEXT_CAP, "text": text[:TEXT_CAP]}

    def _feed_url(self, show: str) -> tuple[str, str]:
        res = self._client.get(ITUNES, params={"term": show, "entity": "podcast",
                                               "limit": 1})
        hits = res.json().get("results", []) if res.status_code == 200 else []
        first = next(iter(hits), {})
        return first.get("feedUrl") or "", first.get("collectionName") or show

    def _episode(self, feed_url: str, episode: str) -> tuple[str, str] | None:
        """The item matching the episode words; without a filter, the newest
        item that actually carries a transcript (else the newest item)."""
        root = ET.fromstring(self._client.get(feed_url).text)
        wanted = episode.lower()
        fallback = None
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            tag = item.find("{*}transcript")
            url = (tag.get("url") if tag is not None else "") or ""
            if wanted:
                if wanted in title.lower():
                    return title, url
                continue
            if url:
                return title, url
            fallback = fallback or (title, url)
        return fallback
