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
    with pytest.raises(ModelsError):
        ModelGateway(tier="nope")


async def test_probe_reports_endpoint_reachability(monkeypatch):
    assert await ModelGateway(tier="fake").probe() is True
    assert await ModelGateway(tier="cloud").probe() is True
    # port 9 (discard) refuses instantly: a dead llama.cpp server reads False
    monkeypatch.setenv("LOCAL_MODEL_URL", "http://127.0.0.1:9/v1")
    assert await ModelGateway(tier="local").probe() is False
    monkeypatch.setenv("MODEL_TIER_DREAM", "fake")
    assert type(ModelGateway(tier="cloud").model_for("dream")).__name__ == "FakeLlm"
    monkeypatch.setenv("MODEL_TIER_CHAT", "clod")  # a typo must raise, never fall through
    with pytest.raises(ModelsError):
        ModelGateway(tier="cloud").model_for("chat")


async def test_fake_tell_returns_valid_json():
    model = ModelGateway(tier="fake").model_for("chat")
    resp = await _run(model, _req(
        "<!-- flow:keeper_tell -->", "I dreamed of Harbor Tower again. It hummed."))
    data = json.loads(resp.content.parts[0].text)
    assert data["title"].startswith("I dreamed of Harbor Tower")
    assert "Harbor Tower" in data["entities"]
    assert resp.usage_metadata.total_token_count > 0


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


async def test_fake_ask_with_no_match_asks_followup():
    model = ModelGateway(tier="fake").model_for("chat")
    resp = await _run(model, _req("<!-- flow:keeper_ask -->\n(no books)", "zzz?"))
    data = json.loads(resp.content.parts[0].text)
    assert data["needs_followup"] and data["used_slugs"] == []


async def test_fake_say_route_is_deterministic():
    model = ModelGateway(tier="fake").model_for("chat")
    resp = await _run(model, _req("<!-- flow:say_route -->", "what did I dream last night?"))
    assert json.loads(resp.content.parts[0].text) == {"kind": "ask"}
    resp = await _run(model, _req("<!-- flow:say_route -->", "I saw a fox by the river."))
    assert json.loads(resp.content.parts[0].text) == {"kind": "tell"}
    resp = await _run(model, _req("<!-- flow:say_route -->", "hello there"))
    assert json.loads(resp.content.parts[0].text) == {"kind": "talk"}
    resp = await _run(model, _req("<!-- flow:keeper_talk -->", "hello there"))
    assert json.loads(resp.content.parts[0].text)["reply"]


async def test_fake_tell_resolves_relative_days_first():
    model = ModelGateway(tier="fake").model_for("chat")
    def resolve_date(phrase: str) -> dict:
        return {"ok": True, "phrase": phrase, "date": "2026-08-23", "weekday": "Sunday"}
    resp = await _run(model, _req("<!-- flow:keeper_tell -->", "I have an interview tomorrow.",
                                  tools={"resolve_date": resolve_date}))
    call = resp.content.parts[0].function_call
    assert call.name == "resolve_date" and call.args == {"phrase": "tomorrow"}


async def test_fake_dark_keeper_opens_a_village_book_then_asks():
    model = ModelGateway(tier="fake").model_for("chat")
    def read_book(keeper_id: str, slug: str) -> dict:
        return {"keeper_id": keeper_id, "slug": slug, "body_md": "x"}
    system = ('<!-- flow:dark_keeper -->\nbecause "the deer" kept returning\n'
              "dreams/2026-08-01-the-deer | 2026-08-01 | a deer in the forest")
    resp = await _run(model, _req(system, "why the deer?", tools={"read_book": read_book}))
    call = resp.content.parts[0].function_call
    assert call.name == "read_book"
    assert call.args == {"keeper_id": "dreams", "slug": "2026-08-01-the-deer"}


async def test_fake_tell_marks_short_remarks_as_notes_about_the_matching_book():
    model = ModelGateway(tier="fake").model_for("chat")
    system = "<!-- flow:keeper_tell -->\nindex:\n2026-08-05-inception-night"
    resp = await _run(model, _req(system, "I liked the ending of Inception."))
    data = json.loads(resp.content.parts[0].text)
    assert data["note"] is True and data["about_slugs"] == ["2026-08-05-inception-night"]
    resp = await _run(model, _req(system, "I dreamed of a harbor tower that hummed all night."))
    assert "note" not in json.loads(resp.content.parts[0].text)


async def test_fake_monument_creates_keeper():
    model = ModelGateway(tier="fake").model_for("chat")
    resp = await _run(model, _req(
        "<!-- flow:monument -->", "please create a keeper for my favorite films"))
    call = resp.content.parts[0].function_call
    assert call.name == "create_keeper" and call.args["topic"] == "my favorite films"


async def test_fake_dream_flows():
    model = ModelGateway(tier="fake").model_for("dream")
    resp = await _run(model, _req("<!-- flow:dream_write -->",
                                  "element: Mars mission\nelement: Aurora"))
    data = json.loads(resp.content.parts[0].text)
    assert "Mars mission" in data["body_md"] and data["name"]

    resp = await _run(model, _req("<!-- flow:dream_narrative -->", "theme: mars-mission"))
    assert "1 thread" in json.loads(resp.content.parts[0].text)["narrative"]
