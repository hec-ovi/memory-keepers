"""The local tier: any OpenAI-compatible chat-completions server, by default
llama.cpp `llama-server --jinja` serving Qwen3.6-35B-A3B."""
import json
import os
from collections.abc import Sequence

import httpx

from .errors import ModelsError
from .reply import Reply, ToolCall

# Local generation is slow: a long book can take minutes on a home machine.
TIMEOUT = httpx.Timeout(600.0, connect=10.0)
PROBE_TIMEOUT = 2.0


def strip_think(content: str) -> str:
    """The answer without the reasoning block Qwen may write first. Templates
    that open `<think>` in the prompt leave only the closing tag in the
    output; an unclosed block is all reasoning."""
    _, closed, answer = content.partition("</think>")
    if closed:
        return answer.strip()
    return "" if content.lstrip().startswith("<think>") else content.strip()


def _arguments(raw) -> dict | None:
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


class LocalModel:
    def __init__(self, base_url: str, model_id: str, key: str | None = None,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self.model_id = model_id
        self._headers = {"Authorization": f"Bearer {key}"} if key else {}
        self._transport = transport  # tests inject httpx.MockTransport

    @classmethod
    def from_env(cls) -> "LocalModel":
        return cls(os.environ.get("LOCAL_MODEL_URL", "http://127.0.0.1:8080/v1"),
                   os.environ.get("LOCAL_MODEL_ID", "qwen3.6-35b-a3b"),
                   os.environ.get("LOCAL_MODEL_KEY"))

    async def complete(self, messages: list[dict], tools: Sequence[dict] = ()) -> Reply:
        payload = {"model": self.model_id, "messages": messages}
        if tools:
            payload["tools"] = list(tools)
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, transport=self._transport) as client:
                response = await client.post(f"{self.base_url}/chat/completions",
                                             json=payload, headers=self._headers)
            response.raise_for_status()
            data = response.json()
            message = data["choices"][0]["message"]
            calls = tuple(
                ToolCall(id=call.get("id") or f"call_{i}", name=call["function"]["name"],
                         arguments=_arguments(call["function"].get("arguments")))
                for i, call in enumerate(message.get("tool_calls") or []))
        except (httpx.HTTPError, ValueError, LookupError, TypeError) as e:
            raise ModelsError(f"local model call failed: {e}") from e
        tokens = (data.get("usage") or {}).get("total_tokens") or 0
        return Reply(text=strip_think(message.get("content") or ""), tool_calls=calls,
                     tokens=int(tokens))

    async def probe(self) -> bool:
        """True when the server lists its models; never raises."""
        try:
            async with httpx.AsyncClient(timeout=PROBE_TIMEOUT, transport=self._transport) as client:
                response = await client.get(f"{self.base_url}/models", headers=self._headers)
            return response.status_code == 200
        except Exception:
            return False
