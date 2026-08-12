import httpx
import pytest
from mk_engine import create_app
from mk_library import Library, seed
from mk_library.testing import FakeFirestore
from mk_models import ModelGateway


@pytest.fixture
def library():
    return Library(FakeFirestore(), seed=seed.apply)


class OfflineLookups:
    """No-network stand-in: every lookup reports unavailable."""

    def youtube_transcript(self, url):
        return {"ok": False, "reason": "unavailable"}

    def song_lyrics(self, title, artist=""):
        return {"ok": False, "reason": "unavailable"}

    def movie_facts(self, title, year=""):
        return {"ok": False, "reason": "unavailable"}

    def movie_plot(self, title, year=""):
        return {"ok": False, "reason": "unavailable"}

    def song_facts(self, title, artist=""):
        return {"ok": False, "reason": "unavailable"}

    def book_facts(self, title):
        return {"ok": False, "reason": "unavailable"}

    def podcast_transcript(self, show, episode=""):
        return {"ok": False, "reason": "unavailable"}


@pytest.fixture
def offline_lookups():
    return OfflineLookups()


@pytest.fixture
def app(library, offline_lookups, monkeypatch):
    monkeypatch.setenv("DREAM_DISPATCH", "inline")
    monkeypatch.setenv("VOICE", "off")
    monkeypatch.delenv("DEV_ROUTES", raising=False)
    return create_app(library=library, gateway=ModelGateway(tier="fake"),
                      lookups=offline_lookups)


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t",
                                 headers={"X-World": "w-test"}) as c:
        yield c


