"""Pins engine/CONTRACT.md end to end: real app, fake Firestore, fake model."""
import asyncio

import pytest
from mk_engine import create_app
from mk_library.limits import SESSION_TOKEN_BUDGET_DEFAULT as BUDGET


async def poll(fn, tries=50):
    for _ in range(tries):
        result = await fn()
        if result is not None:
            return result
        await asyncio.sleep(0.02)
    raise AssertionError("condition never settled")


async def test_health_and_state_boot(client):
    health = (await client.get("/health")).json()
    assert health["status"] == "ok" and health["tier"] == "fake"
    state = (await client.get("/state")).json()
    assert len(state["keepers"]) == 3
    assert state["dream"] == {"latest_run_id": None, "running": False}
    assert state["keepers"][0]["session"]["status"] == "rested"


async def test_world_header_required(client):
    r = await client.get("/state", headers={"X-World": ""})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"


async def test_keeper_lifecycle(client):
    created = await client.post("/keepers", json={"topic": "films"})
    assert created.status_code == 201 and created.json()["level"] == 1
    assert (await client.post("/keepers", json={"topic": "films"})).status_code == 409
    assert (await client.post("/keepers", json={})).status_code == 422
    assert (await client.get("/keepers/films")).json()["topic"] == "films"
    assert (await client.delete("/keepers/films")).json()["deleted"] is True
    assert (await client.get("/keepers/films")).status_code == 404


async def test_tell_ask_and_books(client):
    told = (await client.post("/keepers/dreams/tell",
                              json={"text": "I dreamed of a slow train to Harbor Tower."})).json()
    assert told["book"]["source"] == "told" and told["session"]["tokens_used"] > 0

    asked = (await client.post("/keepers/dreams/ask",
                               json={"question": "what about the train?"})).json()
    assert asked["grounded"] and asked["sources"]

    books = (await client.get("/keepers/dreams/books")).json()
    slug = told["book"]["slug"]
    assert any(b["slug"] == slug for b in books)
    assert "body_md" in (await client.get(f"/keepers/dreams/books/{slug}")).json()
    assert (await client.delete(f"/keepers/dreams/books/{slug}")).json()["deleted"]
    assert (await client.get(f"/keepers/dreams/books/{slug}")).status_code == 404


async def test_chatter_and_monument(client):
    line = (await client.get("/keepers/music/chatter")).json()["line"]
    assert 0 < len(line) < 90
    out = (await client.post("/monument", json={"text": "I want a new keeper for recipes"})).json()
    assert out["created_keeper"]["topic"] == "recipes"


async def test_needs_sleep_gate_and_tired_dream(client, library):
    await client.get("/state")  # creates the world
    library.meter_add("w-test", "meetings", int(BUDGET * 0.9))
    r = await client.post("/keepers/meetings/tell", json={"text": "quick note"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "NEEDS_SLEEP"


async def test_sleep_compacts_and_frees(client, library):
    for i in range(3):
        await client.post("/keepers/music/tell", json={"text": f"Song number {i} stays."})
    job = (await client.post("/keepers/music/sleep")).json()
    assert job["status"] == "running"

    async def done():
        data = (await client.get(f"/keepers/music/sleep/{job['job_id']}")).json()
        return data if data["status"] != "running" else None

    finished = await poll(done)
    assert finished["status"] == "done"
    assert any(b["source"] == "sleep" for b in finished["books_written"])
    assert finished["session"]["tokens_used"] < BUDGET * 0.1
    session = library.session_read("w-test", "music")
    assert len(session.turns) <= 3 and session.sleep_count == 1
    assert (await client.get("/keepers/music/sleep/nope")).status_code == 404


async def test_sleep_running_gates_chat_and_delete(client, library):
    await client.get("/state")  # creates the world
    library.update_keeper("w-test", "dreams", sleep_job={
        "job_id": "sleep-x", "status": "running"})
    for call in (client.post("/keepers/dreams/tell", json={"text": "x"}),
                 client.post("/keepers/dreams/sleep"),
                 client.delete("/keepers/dreams")):
        r = await call
        assert r.status_code == 409 and r.json()["error"]["code"] == "SLEEP_RUNNING"


async def test_dream_end_to_end(client):
    assert (await client.get("/dreams/latest")).status_code == 404
    queued = await client.post("/dream")
    assert queued.status_code == 202 and queued.json()["run_id"]

    async def done():
        r = await client.get("/dreams/latest")
        if r.status_code != 200:
            return None
        return r.json() if r.json()["status"] not in ("queued", "running") else None

    report = await poll(done)
    assert report["run_id"] == queued.json()["run_id"]
    assert report["status"] == "done" and report["narrative"]
    assert report["created_keepers"] and report["graph"]["nodes"]
    state = (await client.get("/state")).json()
    assert any(k["side"] == "dark" for k in state["keepers"])
    assert (await client.get(f"/dreams/{report['run_id']}")).json()["run_id"] == report["run_id"]


async def test_dream_running_conflict(client, library):
    await client.get("/state")  # creates the world
    library.dream_start("w-test", "manual")
    r = await client.post("/dream")
    assert r.status_code == 409 and r.json()["error"]["code"] == "DREAM_RUNNING"


async def test_internal_push_runs_dream(client, monkeypatch):
    import base64
    import json
    monkeypatch.setenv("INTERNAL_TOKEN", "s3cret")
    await client.get("/state")  # creates the world
    payload = base64.b64encode(json.dumps(
        {"world_id": "w-test", "reason": "nightly"}).encode()).decode()
    assert (await client.post("/internal/dream-run",
                              json={"message": {"data": payload}})).status_code == 403
    r = await client.post("/internal/dream-run?token=s3cret",
                          json={"message": {"data": payload}})
    assert r.status_code == 200 and r.json()["status"] in ("done", "failed")


async def test_voice_degrades_without_config(client):
    r = await client.post("/voice/tts", json={"text": "hello"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "VOICE_UNAVAILABLE"


async def test_dev_routes_gated(client, library, monkeypatch):
    assert (await client.post("/dev/reset")).status_code in (404, 405)
    monkeypatch.setenv("DEV_ROUTES", "1")
    import httpx
    from mk_models import ModelGateway
    dev_app = create_app(library=library, gateway=ModelGateway(tier="fake"))
    transport = httpx.ASGITransport(app=dev_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t",
                                 headers={"X-World": "w-dev"}) as dev_client:
        assert (await dev_client.get("/state")).json()["keepers"]
        assert (await dev_client.post("/dev/reset")).json()["reset"] is True


async def test_internal_routes_closed_when_no_token_is_configured(client, monkeypatch):
    monkeypatch.delenv("INTERNAL_TOKEN", raising=False)
    assert (await client.post("/internal/nightly")).status_code == 403
    assert (await client.post("/internal/dream-run", json={})).status_code == 403


async def test_internal_nightly_dispatches_all_worlds(client, monkeypatch):
    monkeypatch.setenv("INTERNAL_TOKEN", "s3cret")
    await client.get("/state")  # creates the world
    assert (await client.post("/internal/nightly")).status_code == 403
    r = await client.post("/internal/nightly?token=s3cret")
    assert r.status_code == 200 and r.json()["dispatched"] >= 1
