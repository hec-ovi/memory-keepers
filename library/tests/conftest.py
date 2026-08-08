import os
import uuid

import pytest
from mk_library import Library, seed
from mk_library.testing import FakeFirestore


@pytest.fixture
def library():
    """Fake client by default; the real client against the emulator when
    FIRESTORE_EMULATOR_HOST is set, same suite either way."""
    if os.environ.get("FIRESTORE_EMULATOR_HOST"):
        from google.cloud import firestore
        client = firestore.Client(project="mk-test")
    else:
        client = FakeFirestore()
    return Library(client, seed=seed.apply)


@pytest.fixture
def world(library):
    wid = f"w-{uuid.uuid4().hex[:8]}"
    library.ensure_world(wid)
    return wid
