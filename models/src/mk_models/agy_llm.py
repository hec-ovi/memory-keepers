"""The agy tier: completions served by whatever CLI is attached to the mk-agy
broker through its MCP toolkit. The whole ADK request (system, conversation,
tools) is flattened into one self-describing prompt; the serving CLI answers
with plain text, or with {"tool_call": {...}} to call a tool. A broker
timeout raises, and every agent flow already survives that deterministically."""
import json
import os
import re
from typing import AsyncGenerator

import httpx
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from .errors import ModelsError

POLL_WAIT_S = 25
FENCE_RE = re.compile(r"^```[a-z]*\n|\n```$")


def new_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=os.environ.get("AGY_BROKER_URL", "http://localhost:8765"), timeout=35)


def timeout_s() -> float:
    return float(os.environ.get("AGY_TIMEOUT_S", "180"))


def flatten(req: LlmRequest, system: str) -> str:
    """One prompt carrying everything: instruction, tools, conversation."""
    lines = [system.strip(), ""]
    tools = req.tools_dict or {}
    if tools:
        lines.append("You can call tools. To call one, reply with ONLY this JSON "
                     'and nothing else: {"tool_call": {"name": "...", "args": {...}}}')
        for name, tool in tools.items():
            doc = " ".join((getattr(tool, "description", "") or
                            getattr(getattr(tool, "func", None), "__doc__", "") or "").split())
            lines.append(f"- {name}: {doc}")
        lines.append("")
    lines.append("Conversation so far:")
    for content in req.contents:
        for part in content.parts or []:
            if part.text:
                lines.append(f"[{content.role}] {part.text}")
            if part.function_call is not None:
                lines.append(f"[model tool_call] {part.function_call.name}"
                             f"({json.dumps(dict(part.function_call.args or {}))})")
            if part.function_response is not None:
                lines.append(f"[tool {part.function_response.name}] "
                             f"{json.dumps(part.function_response.response, default=str)}")
    lines.append("")
    lines.append("Reply now as the model, exactly in the format the instruction "
                 "asks for (or a tool_call JSON).")
    return "\n".join(lines)


def parse(text: str) -> types.Content:
    cleaned = FENCE_RE.sub("", text.strip()).strip()
    try:
        data = json.loads(cleaned)
        call = data.get("tool_call") if isinstance(data, dict) else None
        if isinstance(call, dict) and call.get("name"):
            return types.Content(role="model", parts=[types.Part(
                function_call=types.FunctionCall(name=call["name"],
                                                 args=call.get("args") or {}))])
    except ValueError:
        pass
    return types.Content(role="model", parts=[types.Part(text=text)])


class AgyLlm(BaseLlm):
    model: str = "agy-1"

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        system = llm_request.config.system_instruction or ""
        if not isinstance(system, str):
            system = getattr(system, "text", "") or str(system)
        prompt = flatten(llm_request, system)
        async with new_client() as client:
            res = await client.post("/jobs", json={"prompt": prompt})
            job_id = res.json().get("job_id")
            if not job_id:
                raise ModelsError("agy broker refused the job")
            waited = 0.0
            while True:
                poll = (await client.get(f"/jobs/{job_id}",
                                         params={"wait": POLL_WAIT_S})).json()
                if poll.get("status") == "done":
                    text = poll.get("reply") or ""
                    break
                waited += POLL_WAIT_S
                if waited >= timeout_s():
                    raise ModelsError("no CLI answered the agy job in time")
        content = parse(text)
        prompt_tokens = len(prompt) // 4
        out_tokens = sum(len(p.text or "") + (40 if p.function_call else 0)
                         for p in content.parts) // 4
        yield LlmResponse(
            content=content,
            usage_metadata=types.GenerateContentResponseUsageMetadata(
                prompt_token_count=prompt_tokens, candidates_token_count=out_tokens,
                total_token_count=prompt_tokens + out_tokens),
        )
