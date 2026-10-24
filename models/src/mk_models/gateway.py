"""The only place a model is configured. Tiers: local (an OpenAI-compatible
server, Qwen on llama.cpp by default), fake (deterministic, dev and tests)."""
import os

from .errors import ModelsError
from .fake import FakeModel
from .local import LocalModel

ROLES = ("chat", "dream")
TIERS = ("local", "fake")


class ModelGateway:
    def __init__(self, tier: str | None = None):
        self._tier = tier or os.environ.get("MODEL_TIER", "local")
        if self._tier not in TIERS:
            raise ModelsError(f"unknown MODEL_TIER {self._tier!r}")

    def tier(self) -> str:
        return self._tier

    async def probe(self) -> bool:
        """True when the tier's model endpoint answers: the local server lists
        its models (2 s, never raises); fake reports True."""
        return await LocalModel.from_env().probe() if self._tier == "local" else True

    def model_for(self, role: str) -> LocalModel | FakeModel:
        assert role in ROLES
        tier = os.environ.get(f"MODEL_TIER_{role.upper()}") or self._tier
        if tier not in TIERS:
            raise ModelsError(f"unknown MODEL_TIER_{role.upper()} {tier!r}")
        return LocalModel.from_env() if tier == "local" else FakeModel()
