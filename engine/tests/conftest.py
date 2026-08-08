import httpx
import pytest
from mk_engine import create_app
from mk_library import Library, seed
from mk_library.testing import FakeFirestore
from mk_models import ModelGateway


@pytest.fixture
def library():
    return Library(FakeFirestore(), seed=seed.apply)


@pytest.fixture
def app(library, monkeypatch):
    monkeypatch.setenv("DREAM_DISPATCH", "inline")
    monkeypatch.delenv("DEV_ROUTES", raising=False)
    return create_app(library=library, gateway=ModelGateway(tier="fake"))


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t",
                                 headers={"X-World": "w-test"}) as c:
        yield c


