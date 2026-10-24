import uuid

import pytest
from mk_library import Library, seed


@pytest.fixture
def library():
    return Library(":memory:", seed=seed.apply)


@pytest.fixture
def world(library):
    wid = f"w-{uuid.uuid4().hex[:8]}"
    library.ensure_world(wid)
    return wid
