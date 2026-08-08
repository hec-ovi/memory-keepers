import pytest
from mk_agents import AgentsApi
from mk_library import Library, seed
from mk_library.testing import FakeFirestore
from mk_models import ModelGateway


@pytest.fixture
def library():
    return Library(FakeFirestore(), seed=seed.apply)


@pytest.fixture
def api(library):
    library.ensure_world("w")
    return AgentsApi(library, ModelGateway(tier="fake"))
