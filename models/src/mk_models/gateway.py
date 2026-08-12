"""The only place a model is configured. Tiers: cloud (Gemini on Vertex),
local (OpenAI-compatible llama.cpp), agy (a CLI brain over the mk-agy broker),
fake (deterministic, dev and tests)."""
import os

from .errors import ModelsError

ROLES = ("chat", "dream")
TIERS = ("cloud", "local", "agy", "fake")


class ModelGateway:
    def __init__(self, tier: str | None = None):
        self._tier = tier or os.environ.get("MODEL_TIER", "cloud")
        if self._tier not in TIERS:
            raise ModelsError(f"unknown MODEL_TIER {self._tier!r}")

    def tier(self) -> str:
        return self._tier

    def model_for(self, role: str):
        assert role in ROLES
        tier = os.environ.get(f"MODEL_TIER_{role.upper()}") or self._tier
        if tier not in TIERS:
            raise ModelsError(f"unknown MODEL_TIER_{role.upper()} {tier!r}")
        if tier == "cloud":
            from google.adk.models.google_llm import Gemini
            return Gemini(model=os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"))
        if tier == "agy":
            try:
                from .agy_llm import AgyLlm
            except ImportError as e:
                raise ModelsError("agy tier needs the mk-models[agy] extra") from e
            return AgyLlm()
        if tier == "local":
            try:
                from google.adk.models.lite_llm import LiteLlm
            except ImportError as e:
                raise ModelsError("local tier needs the mk-models[local] extra") from e
            return LiteLlm(
                model=f"openai/{os.environ.get('LOCAL_MODEL_ID', 'gemma-4-26b-a4b-qat-q4')}",
                api_base=os.environ.get("LOCAL_MODEL_URL", "http://127.0.0.1:8080/v1"),
                api_key=os.environ.get("LOCAL_MODEL_KEY", "local"),
            )
        from .fake_llm import FakeLlm
        return FakeLlm()
