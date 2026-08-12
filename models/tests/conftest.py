import pytest


@pytest.fixture(autouse=True)
def _clean_model_env(monkeypatch):
    for var in ("MODEL_TIER", "MODEL_TIER_CHAT", "MODEL_TIER_DREAM"):
        monkeypatch.delenv(var, raising=False)
