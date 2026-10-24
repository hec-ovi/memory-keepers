"""The one reply shape every tier returns: a model call, normalized."""
import json
from dataclasses import dataclass


@dataclass(frozen=True)
class ToolCall:
    """One function call the model asked for. `arguments` is None when the
    model's arguments did not decode to a JSON object."""
    id: str
    name: str
    arguments: dict | None


@dataclass(frozen=True)
class Reply:
    """The assistant's text (reasoning removed), the tool calls it asked for,
    and the call's total token count (0 when the server reports none)."""
    text: str
    tool_calls: tuple[ToolCall, ...] = ()
    tokens: int = 0

    def message(self) -> dict:
        """This reply as the assistant message that carries it into the next request."""
        message = {"role": "assistant", "content": self.text}
        if self.tool_calls:
            message["tool_calls"] = [
                {"id": call.id, "type": "function",
                 "function": {"name": call.name, "arguments": json.dumps(call.arguments or {})}}
                for call in self.tool_calls]
        return message
