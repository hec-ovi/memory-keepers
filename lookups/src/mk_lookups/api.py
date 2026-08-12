"""Facade of the lookups box: one client, many lookups, no exceptions out."""
import os

import httpx

from .books import BookFacts
from .lyrics import LyricsLookup
from .movies import MovieLookup
from .podcasts import PodcastTranscript
from .songs import SongFacts
from .youtube import TranscriptLookup

USER_AGENT = "memory-keepers/0.6 (+https://github.com/hec-ovi/memory-keepers)"
TIMEOUT_S = 8


class LookupsApi:
    """Every method returns {"ok": True, ...} or {"ok": False, "reason": str}
    and never raises: a dead lookup can never break a keeper flow.

    client and transcript_fetch are injectable for tests; env defaults to
    os.environ (keys read: OMDB_KEY)."""

    def __init__(self, client: httpx.Client | None = None,
                 transcript_fetch=None, env=None):
        self._client = client or httpx.Client(timeout=TIMEOUT_S, follow_redirects=True)
        # The distinctive UA is load-bearing: LRCLIB drops disfavored agents.
        self._client.headers["User-Agent"] = USER_AGENT
        env = os.environ if env is None else env
        self._youtube = TranscriptLookup(transcript_fetch)
        self._lyrics = LyricsLookup(self._client)
        self._movies = MovieLookup(self._client, env)
        self._songs = SongFacts(self._client)
        self._books = BookFacts(self._client)
        self._podcasts = PodcastTranscript(self._client)

    def youtube_transcript(self, url_or_id: str) -> dict:
        return self._youtube.transcript(url_or_id)

    def song_lyrics(self, title: str, artist: str = "") -> dict:
        return self._lyrics.lyrics(title, artist)

    def movie_facts(self, title: str, year: str = "") -> dict:
        return self._movies.facts(title, year)

    def movie_plot(self, title: str, year: str = "") -> dict:
        return self._movies.plot(title, year)

    def song_facts(self, title: str, artist: str = "") -> dict:
        return self._songs.facts(title, artist)

    def book_facts(self, title: str) -> dict:
        return self._books.facts(title)

    def podcast_transcript(self, show: str, episode: str = "") -> dict:
        return self._podcasts.transcript(show, episode)
