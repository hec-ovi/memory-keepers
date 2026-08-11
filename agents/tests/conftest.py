import pytest
from mk_agents import AgentsApi
from mk_library import Library, seed
from mk_library.testing import FakeFirestore
from mk_models import ModelGateway


@pytest.fixture
def library():
    return Library(FakeFirestore(), seed=seed.apply)


class RecordingLookups:
    """Offline LookupsApi stand-in: canned results, calls recorded."""

    def __init__(self):
        self.calls = []

    def youtube_transcript(self, url):
        self.calls.append(("youtube", url))
        return {"ok": True, "video_id": "x" * 11, "truncated": False,
                "text": "we choose to go to the moon"}

    def song_lyrics(self, title, artist=""):
        self.calls.append(("lyrics", title))
        return {"ok": True, "source": "lrclib", "title": title,
                "artist": artist or "Queen", "lyrics": "is this the real life"}

    def movie_facts(self, title, year=""):
        self.calls.append(("movie", title))
        return {"ok": True, "source": "omdb", "title": title, "year": "2010",
                "director": "Christopher Nolan", "cast": ["Leonardo DiCaprio"],
                "plot": "A thief steals secrets through dreams.",
                "imdb_rating": "8.8"}

    def movie_plot(self, title, year=""):
        self.calls.append(("plot", title))
        return {"ok": True, "source": "wikipedia", "title": title,
                "summary": "a 2010 film", "plot": "Cobb plants an idea.",
                "url": "https://en.wikipedia.org/wiki/Inception",
                "license": "CC BY-SA 4.0"}

    def song_facts(self, title, artist=""):
        self.calls.append(("song_facts", title))
        return {"ok": True, "source": "musicbrainz", "title": title,
                "artist": artist or "Pink Floyd", "year": "1973",
                "album": "The Dark Side of the Moon"}

    def book_facts(self, title):
        self.calls.append(("book_facts", title))
        return {"ok": True, "source": "gutendex", "title": title,
                "author": "Twain, Mark", "author_years": "1835-1910",
                "subjects": ["Mississippi River"], "public_domain": True,
                "text_url": "https://www.gutenberg.org/ebooks/76.txt.utf-8"}

    def podcast_transcript(self, show, episode=""):
        self.calls.append(("podcast", show))
        return {"ok": True, "source": "rss", "show": show, "episode": "Ep 2",
                "truncated": False, "text": "we begin at night"}


@pytest.fixture
def lookups():
    return RecordingLookups()


@pytest.fixture
def api(library, lookups):
    library.ensure_world("w")
    return AgentsApi(library, ModelGateway(tier="fake"), lookups)
