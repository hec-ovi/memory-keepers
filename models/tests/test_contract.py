"""Pins models/CONTRACT.md: tier selection, the local mapping, the fake tier's behavior."""
import json

import httpx
import pytest
from mk_models import ModelGateway, ModelsError
from mk_models.local import LocalModel


def _tools(*names):
    return [{"type": "function", "function": {"name": n, "parameters": {"type": "object"}}}
            for n in names]


async def _ask(model, system, user, extra=(), tools=()):
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}, *extra]
    return await model.complete(messages, _tools(*tools))


def test_tiers(monkeypatch):
    assert ModelGateway().tier() == "local"  # the default
    assert type(ModelGateway(tier="fake").model_for("chat")).__name__ == "FakeModel"
    assert type(ModelGateway(tier="local").model_for("chat")).__name__ == "LocalModel"
    with pytest.raises(ModelsError):
        ModelGateway(tier="nope")
    monkeypatch.setenv("MODEL_TIER_DREAM", "fake")
    assert type(ModelGateway(tier="local").model_for("dream")).__name__ == "FakeModel"
    monkeypatch.setenv("MODEL_TIER_CHAT", "locl")  # a typo must raise, never fall through
    with pytest.raises(ModelsError):
        ModelGateway(tier="local").model_for("chat")


async def test_probe_reports_endpoint_reachability(monkeypatch):
    assert await ModelGateway(tier="fake").probe() is True
    # port 9 (discard) refuses instantly: a dead server reads False
    monkeypatch.setenv("LOCAL_MODEL_URL", "http://127.0.0.1:9/v1")
    assert await ModelGateway(tier="local").probe() is False


async def test_local_tier_maps_openai_requests_and_replies():
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "qwen3.6-35b-a3b"}]})
        return httpx.Response(200, json={
            "choices": [{"message": {
                "content": "<think>which tool?</think>\nOpening the book.",
                "reasoning_content": "ignored",
                "tool_calls": [
                    {"id": "c1", "type": "function",
                     "function": {"name": "read_book", "arguments": '{"slug": "2026-08-05-x"}'}},
                    {"id": "c2", "type": "function",
                     "function": {"name": "read_book", "arguments": "{not json"}}]}}],
            "usage": {"prompt_tokens": 90, "completion_tokens": 30, "total_tokens": 120}})

    model = LocalModel("http://srv/v1", "qwen3.6-35b-a3b", key="k",
                       transport=httpx.MockTransport(handler))
    tools = _tools("read_book")
    reply = await model.complete([{"role": "user", "content": "hi"}], tools)
    body = json.loads(sent[0].content)
    assert str(sent[0].url) == "http://srv/v1/chat/completions"
    assert sent[0].headers["authorization"] == "Bearer k"
    assert body["model"] == "qwen3.6-35b-a3b" and body["tools"] == tools
    assert not {"max_tokens", "max_completion_tokens", "n_predict"} & set(body)
    assert reply.text == "Opening the book." and reply.tokens == 120
    assert [(c.id, c.name, c.arguments) for c in reply.tool_calls] == [
        ("c1", "read_book", {"slug": "2026-08-05-x"}), ("c2", "read_book", None)]
    assert reply.message()["tool_calls"][1]["function"]["arguments"] == "{}"

    await LocalModel("http://srv/v1", "m", transport=httpx.MockTransport(handler)).complete(
        [{"role": "user", "content": "hi"}])
    assert "authorization" not in sent[1].headers and "tools" not in json.loads(sent[1].content)
    assert await model.probe() is True


async def test_local_tier_failure_is_a_models_error():
    dead = httpx.MockTransport(lambda request: httpx.Response(503))
    with pytest.raises(ModelsError):
        await LocalModel("http://srv/v1", "m", transport=dead).complete(
            [{"role": "user", "content": "hi"}])


def test_think_blocks_are_stripped():
    from mk_models.local import strip_think
    assert strip_think("<think>a</think>\n{\"x\": 1}") == '{"x": 1}'
    assert strip_think("reasoning only closes</think>answer") == "answer"
    assert strip_think("<think>never closed") == ""
    assert strip_think(" plain ") == "plain"


async def test_fake_tell_returns_valid_json():
    model = ModelGateway(tier="fake").model_for("chat")
    reply = await _ask(model, "<!-- flow:keeper_tell -->",
                       "I dreamed of Harbor Tower again. It hummed.")
    data = json.loads(reply.text)
    assert data["title"].startswith("I dreamed of Harbor Tower")
    assert "Harbor Tower" in data["entities"]
    assert reply.tokens > 0


async def test_fake_ask_reads_then_answers():
    model = ModelGateway(tier="fake").model_for("chat")
    system = "<!-- flow:keeper_ask -->\nindex:\n2026-08-05-rehearsing-the-launch\n2026-08-02-the-glass-elevator"
    question = "what did I dream about the launch?"
    first = await _ask(model, system, question, tools=["read_book"])
    call = first.tool_calls[0]
    assert call.name == "read_book" and call.arguments["slug"] == "2026-08-05-rehearsing-the-launch"

    result = {"role": "tool", "tool_call_id": call.id, "content": json.dumps(
        {"slug": "2026-08-05-rehearsing-the-launch", "date": "2026-08-05",
         "body_md": "I waited for the countdown."})}
    data = json.loads((await _ask(model, system, question, extra=[first.message(), result])).text)
    assert data["used_slugs"] == ["2026-08-05-rehearsing-the-launch"]
    assert not data["needs_followup"] and "countdown" in data["answer"]


async def test_fake_ask_with_no_match_asks_followup():
    model = ModelGateway(tier="fake").model_for("chat")
    data = json.loads((await _ask(model, "<!-- flow:keeper_ask -->\n(no books)", "zzz?")).text)
    assert data["needs_followup"] and data["used_slugs"] == []


async def test_fake_say_route_is_deterministic():
    model = ModelGateway(tier="fake").model_for("chat")
    route = "<!-- flow:say_route -->"
    assert json.loads((await _ask(model, route, "what did I dream last night?")).text) == {"kind": "ask"}
    assert json.loads((await _ask(model, route, "I saw a fox by the river.")).text) == {"kind": "tell"}
    assert json.loads((await _ask(model, route, "hello there")).text) == {"kind": "talk"}
    assert json.loads((await _ask(model, "<!-- flow:keeper_talk -->", "hello there")).text)["reply"]


async def test_fake_tell_resolves_relative_days_first():
    model = ModelGateway(tier="fake").model_for("chat")
    reply = await _ask(model, "<!-- flow:keeper_tell -->", "I have an interview tomorrow.",
                       tools=["resolve_date"])
    call = reply.tool_calls[0]
    assert call.name == "resolve_date" and call.arguments == {"phrase": "tomorrow"}


async def test_fake_dark_keeper_opens_a_village_book_then_asks():
    model = ModelGateway(tier="fake").model_for("chat")
    system = ('<!-- flow:dark_keeper -->\nbecause "the deer" kept returning\n'
              "dreams/2026-08-01-the-deer | 2026-08-01 | a deer in the forest")
    call = (await _ask(model, system, "why the deer?", tools=["read_book"])).tool_calls[0]
    assert call.name == "read_book"
    assert call.arguments == {"keeper_id": "dreams", "slug": "2026-08-01-the-deer"}


async def test_fake_tell_marks_short_remarks_as_notes_about_the_matching_book():
    model = ModelGateway(tier="fake").model_for("chat")
    system = "<!-- flow:keeper_tell -->\nindex:\n2026-08-05-inception-night"
    data = json.loads((await _ask(model, system, "I liked the ending of Inception.")).text)
    assert data["note"] is True and data["about_slugs"] == ["2026-08-05-inception-night"]
    reply = await _ask(model, system, "I dreamed of a harbor tower that hummed all night.")
    assert "note" not in json.loads(reply.text)


async def test_fake_monument_creates_keeper():
    model = ModelGateway(tier="fake").model_for("chat")
    reply = await _ask(model, "<!-- flow:monument -->",
                       "please create a keeper for my favorite films", tools=["create_keeper"])
    call = reply.tool_calls[0]
    assert call.name == "create_keeper" and call.arguments["topic"] == "my favorite films"


async def test_fake_dream_flows():
    model = ModelGateway(tier="fake").model_for("dream")
    data = json.loads((await _ask(model, "<!-- flow:dream_write -->",
                                  "element: Mars mission\nelement: Aurora")).text)
    assert "Mars mission" in data["body_md"] and data["name"]
    reply = await _ask(model, "<!-- flow:dream_narrative -->", "theme: mars-mission")
    assert "1 thread" in json.loads(reply.text)["narrative"]
