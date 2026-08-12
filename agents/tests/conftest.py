import pytest
from mk_agents import AgentsApi
from mk_library import Library, seed
from mk_library.testing import FakeFirestore
from mk_models import ModelGateway


@pytest.fixture
def library():
    return Library(FakeFirestore(), seed=seed.apply)


class RecordingLookups:
    """Offline LookupsApi stand-in: canned results for the branches the fake
    tier dispatches in these tests, calls recorded."""

    def __init__(self):
        self.calls = []

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

    def song_facts(self, title, artist=""):
        self.calls.append(("song_facts", title))
        return {"ok": True, "source": "musicbrainz", "title": title,
                "artist": artist or "Pink Floyd", "year": "1973",
                "album": "The Dark Side of the Moon"}


@pytest.fixture
def lookups():
    return RecordingLookups()


@pytest.fixture
def api(library, lookups):
    library.ensure_world("w")
    return AgentsApi(library, ModelGateway(tier="fake"), lookups)
