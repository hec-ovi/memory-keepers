"""Pins models/CONTRACT.md: tier selection and the fake tier's behavior."""
import json

import pytest
from google.adk.models.llm_request import LlmRequest
from google.genai import types
from mk_models import ModelGateway, ModelsError


def _req(system: str, user: str, contents_extra=None, tools=None):
    req = LlmRequest(contents=[
        types.Content(role="user", parts=[types.Part(text=user)]),
        *(contents_extra or []),
    ])
    req.config.system_instruction = system
    req.tools_dict = tools or {}
    return req


async def _run(model, req):
    return [r async for r in model.generate_content_async(req)][-1]


def test_tiers(monkeypatch):
    assert ModelGateway(tier="fake").tier() == "fake"
    assert type(ModelGateway(tier="cloud").model_for("chat")).__name__ == "Gemini"
    monkeypatch.setenv("LOCAL_MODEL_URL", "http://127.0.0.1:9/v1")
    assert type(ModelGateway(tier="local").model_for("chat")).__name__ == "LiteLlm"
    assert type(ModelGateway(tier="agy").model_for("chat")).__name__ == "AgyLlm"
    with pytest.raises(ModelsError):
        ModelGateway(tier="nope")
    monkeypatch.setenv("MODEL_TIER_DREAM", "fake")
    assert type(ModelGateway(tier="cloud").model_for("dream")).__name__ == "FakeLlm"
    monkeypatch.setenv("MODEL_TIER_CHAT", "clod")  # a typo must raise, never fall through
    with pytest.raises(ModelsError):
        ModelGateway(tier="cloud").model_for("chat")


@pytest.mark.asyncio
async def test_fake_tell_returns_valid_json():
    model = ModelGateway(tier="fake").model_for("chat")
    resp = await _run(model, _req(
        "<!-- flow:keeper_tell -->", "I dreamed of Harbor Tower again. It hummed."))
    data = json.loads(resp.content.parts[0].text)
    assert data["title"].startswith("I dreamed of Harbor Tower")
    assert "Harbor Tower" in data["entities"]
    assert resp.usage_metadata.total_token_count > 0


@pytest.mark.asyncio
async def test_fake_ask_reads_then_answers():
    model = ModelGateway(tier="fake").model_for("chat")
    system = "<!-- flow:keeper_ask -->\nindex:\n2026-08-05-rehearsing-the-launch\n2026-08-02-the-glass-elevator"
    first = await _run(model, _req(system, "what did I dream about the launch?"))
    call = first.content.parts[0].function_call
    assert call.name == "read_book" and call.args["slug"] == "2026-08-05-rehearsing-the-launch"

    followup = _req(system, "what did I dream about the launch?", contents_extra=[
        types.Content(role="user", parts=[types.Part(function_response=types.FunctionResponse(
            name="read_book", response={"slug": "2026-08-05-rehearsing-the-launch",
                                        "date": "2026-08-05",
                                        "body_md": "I waited for the countdown."}))])])
    resp = await _run(model, followup)
    data = json.loads(resp.content.parts[0].text)
    assert data["used_slugs"] == ["2026-08-05-rehearsing-the-launch"]
    assert not data["needs_followup"] and "countdown" in data["answer"]


@pytest.mark.asyncio
async def test_fake_ask_with_no_match_asks_followup():
    model = ModelGateway(tier="fake").model_for("chat")
    resp = await _run(model, _req("<!-- flow:keeper_ask -->\n(no books)", "zzz?"))
    data = json.loads(resp.content.parts[0].text)
    assert data["needs_followup"] and data["used_slugs"] == []


@pytest.mark.asyncio
async def test_fake_monument_creates_keeper():
    model = ModelGateway(tier="fake").model_for("chat")
    resp = await _run(model, _req(
        "<!-- flow:monument -->", "please create a keeper for my favorite films"))
    call = resp.content.parts[0].function_call
    assert call.name == "create_keeper" and call.args["topic"] == "my favorite films"


@pytest.mark.asyncio
async def test_fake_dream_flows():
    model = ModelGateway(tier="fake").model_for("dream")
    resp = await _run(model, _req("<!-- flow:dream_write -->",
                                  "element: Mars mission\nelement: Aurora"))
    data = json.loads(resp.content.parts[0].text)
    assert "Mars mission" in data["body_md"] and data["name"]

    resp = await _run(model, _req("<!-- flow:dream_narrative -->", "theme: mars-mission"))
    assert "1 thread" in json.loads(resp.content.parts[0].text)["narrative"]


async def test_agy_tier_round_trips_through_the_broker(monkeypatch):
    """The agy tier posts one flattened prompt, long-polls, and parses either
    a plain reply or a tool_call JSON from whatever CLI served the job."""
    import httpx
    from mk_models import agy_llm

    served: dict = {}

    def handler(request):
        if request.method == "POST" and request.url.path == "/jobs":
            served["prompt"] = json.loads(request.content)["prompt"]
            return httpx.Response(201, json={"job_id": "j-1"})
        assert request.url.path == "/jobs/j-1"
        return httpx.Response(200, json={"status": "done", "reply": served["reply"]})

    monkeypatch.setattr(agy_llm, "new_client", lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://b"))
    model = ModelGateway(tier="agy").model_for("chat")

    def read_book(slug: str) -> dict:
        """Open one book by its slug."""

    served["reply"] = "It is on the shelf now."
    res = await _run(model, _req("<!-- flow:keeper_tell -->\nKeep memories.", "I saw a fox",
                                 tools={"read_book": read_book}))
    assert res.content.parts[0].text == "It is on the shelf now."
    assert res.usage_metadata.total_token_count > 0
    prompt = served["prompt"]
    assert "Keep memories." in prompt and "[user] I saw a fox" in prompt
    assert "read_book" in prompt and "tool_call" in prompt  # the tool protocol rides along

    served["reply"] = '{"tool_call": {"name": "read_book", "args": {"slug": "2026-08-01-fox"}}}'
    res = await _run(model, _req("ask", "what fox?", tools={"read_book": read_book}))
    call = res.content.parts[0].function_call
    assert call.name == "read_book" and dict(call.args) == {"slug": "2026-08-01-fox"}
