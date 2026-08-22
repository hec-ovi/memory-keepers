"""One place that touches ADK's Runner: run an agent for one message and
return its final text plus token usage. Durable memory lives in the library,
so every run gets a fresh in-memory session."""
import json

from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.adk.agents.llm_agent import LlmAgent
from google.adk.agents.run_config import RunConfig
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.genai import types

# One run is a handful of model calls (a lookup, a date, a book read, the
# reply). A model that keeps calling tools stops at the cap, or earlier, the
# moment it repeats a call it already made.
MAX_LLM_CALLS = 12
LOOKUP_NOTE_CHARS = 1500


def build_agent(name: str, model, instruction: str, tools: list) -> LlmAgent:
    return LlmAgent(name=name, model=model, instruction=instruction, tools=tools)


async def _run(agent: LlmAgent, user_text: str) -> tuple[str, int, list[dict], bool]:
    """Streams one run. Returns (final text, tokens, lookups made, stuck):
    stuck when the model repeated an identical tool call or hit the cap."""
    service = InMemorySessionService()
    runner = Runner(agent=agent, app_name="memory-keepers", session_service=service)
    session = await service.create_session(app_name="memory-keepers", user_id="player")
    final_text, tokens, lookups, seen, stuck = "", 0, [], set(), False
    events = runner.run_async(
        user_id="player", session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part(text=user_text)]),
        run_config=RunConfig(max_llm_calls=MAX_LLM_CALLS),
    )
    try:
        async for event in events:
            usage = getattr(event, "usage_metadata", None)
            if usage and usage.total_token_count:
                tokens += usage.total_token_count
            parts = event.content.parts if event.content and event.content.parts else []
            for part in parts:
                if part.function_call:
                    key = (part.function_call.name, json.dumps(dict(part.function_call.args or {}), sort_keys=True))
                    if key in seen:
                        stuck = True
                    seen.add(key)
                elif part.function_response:
                    lookups.append({"name": part.function_response.name,
                                    "response": part.function_response.response})
            if event.content and event.content.role == "model":
                texts = [p.text for p in parts if p.text]
                if texts:
                    final_text = "\n".join(texts)
            if stuck:
                break
    except LlmCallsLimitExceededError:
        stuck = True
    finally:
        await events.aclose()
    return final_text, tokens, lookups, stuck


async def run_agent(agent: LlmAgent, user_text: str) -> tuple[str, int]:
    text, tokens, _, _ = await _run(agent, user_text)
    return text, tokens


def lookup_note(lookups: list[dict]) -> str:
    lines = []
    for item in lookups:
        result = json.dumps(item["response"], ensure_ascii=False)[:LOOKUP_NOTE_CHARS]
        lines.append(f"- {item['name']} -> {result}")
    return ("\n\nLookups already made for this message (their results; nothing "
            "else to call):\n" + "\n".join(lines)) if lines else ""


async def run_flow(name: str, model, instruction: str, tools: list, user_text: str,
                   accept=lambda text: bool(text.strip())) -> tuple[str, int]:
    """One flow, end to end. The model gathers what it needs with its tools;
    when that pass does not end in an accepted answer (it looped, hit the cap,
    or wrote something else), the model writes once more without tools,
    carrying the lookups it made. The deterministic fallback stays with the
    caller, for a second failure."""
    text, tokens, lookups, stuck = await _run(build_agent(name, model, instruction, tools), user_text)
    if not stuck and accept(text):
        return text, tokens
    again = build_agent(name, model, instruction + lookup_note(lookups), [])
    text2, tokens2 = await run_agent(again, user_text)
    return text2, tokens + tokens2
