"""The tool-calling loop every agent runs on: one agent, one user message,
final text plus token usage. Durable memory lives in the library, so every
run starts from the instruction and the message alone."""
import asyncio
import inspect
import json
import logging

log = logging.getLogger(__name__)

# One run is a handful of model calls (a lookup, a date, a book read, the
# reply). A model that keeps calling tools stops at the cap, or earlier, the
# moment it repeats a call it already made.
MAX_LLM_CALLS = 12
LOOKUP_NOTE_CHARS = 1500
JSON_TYPES = {str: "string", int: "integer", float: "number", bool: "boolean"}


def tool_schema(fn) -> dict:
    """The OpenAI function-tool schema of a plain function: its name, its
    docstring, one property per parameter (required when it has no default)."""
    params = inspect.signature(fn).parameters
    return {"type": "function", "function": {
        "name": fn.__name__, "description": inspect.getdoc(fn) or "",
        "parameters": {
            "type": "object",
            "properties": {n: {"type": JSON_TYPES.get(p.annotation, "string")}
                           for n, p in params.items()},
            "required": [n for n, p in params.items() if p.default is inspect.Parameter.empty],
        }}}


class Agent:
    """A model, its instruction (the system message) and its tools: plain
    functions, sync or async."""

    def __init__(self, name: str, model, instruction: str, tools=()):
        self.name, self.model, self.instruction = name, model, instruction
        self.tools = {fn.__name__: fn for fn in tools}
        self.schemas = [tool_schema(fn) for fn in tools]

    async def run(self, user_text: str) -> tuple[str, int]:
        text, tokens, _, _ = await self._run(user_text)
        return text, tokens

    async def _run(self, user_text: str) -> tuple[str, int, list[tuple[str, str]], bool]:
        """Returns (final text, tokens, tool results, stuck): tokens is the
        largest total one call carried (the last call holds every earlier
        round), so tool rounds do not count the prompt again and again; stuck
        when the model repeated an identical tool call or hit the cap."""
        messages = [{"role": "system", "content": self.instruction},
                    {"role": "user", "content": user_text}]
        text, tokens, results, seen = "", 0, [], set()
        for _ in range(MAX_LLM_CALLS):
            reply = await self.model.complete(messages, self.schemas)
            tokens = max(tokens, reply.tokens)
            text = reply.text or text
            if not reply.tool_calls:
                return text, tokens, results, False
            messages.append(reply.message())
            for call in reply.tool_calls:
                key = (call.name, json.dumps(call.arguments, sort_keys=True))
                if key in seen:
                    log.warning("%s repeated %s, stopping the run", self.name, call.name)
                    return text, tokens, results, True
                seen.add(key)
                content = await self._call(call)
                results.append((call.name, content))
                messages.append({"role": "tool", "tool_call_id": call.id, "content": content})
        log.warning("%s hit %d model calls, stopping the run", self.name, MAX_LLM_CALLS)
        return text, tokens, results, True

    async def _call(self, call) -> str:
        """One tool call; whatever goes wrong goes back to the model as an
        error result. Sync tools run off the event loop."""
        fn = self.tools.get(call.name)
        if fn is None:
            result = {"error": f"no tool named {call.name}"}
        elif call.arguments is None:
            result = {"error": "the arguments were not a JSON object"}
        else:
            try:
                result = await fn(**call.arguments) if inspect.iscoroutinefunction(fn) \
                    else await asyncio.to_thread(fn, **call.arguments)
            except Exception as e:
                log.warning("%s: tool %s failed: %s", self.name, call.name, e)
                result = {"error": f"{type(e).__name__}: {e}"}
        return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)


def lookup_note(results: list[tuple[str, str]]) -> str:
    lines = [f"- {name} -> {content[:LOOKUP_NOTE_CHARS]}" for name, content in results]
    return ("\n\nLookups already made for this message (their results; nothing "
            "else to call):\n" + "\n".join(lines)) if lines else ""


async def run_flow(agent: Agent, user_text: str,
                   accept=lambda text: bool(text.strip())) -> tuple[str, int]:
    """One flow, end to end. The model gathers what it needs with its tools;
    when that pass does not end in an accepted answer (it looped, hit the cap,
    or wrote something else), the model writes once more without tools,
    carrying the tool results as text; the second pass adds its own tokens.
    The deterministic fallback stays with the caller, for a second failure."""
    text, tokens, results, stuck = await agent._run(user_text)
    if not stuck and accept(text):
        return text, tokens
    again = Agent(agent.name, agent.model, agent.instruction + lookup_note(results))
    text2, tokens2 = await again.run(user_text)
    return text2, tokens + tokens2
