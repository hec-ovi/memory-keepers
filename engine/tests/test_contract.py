"""Pins engine/CONTRACT.md end to end: real app, in-memory library, fake model."""
import asyncio

import pytest
from mk_engine import create_app
from mk_library.limits import SESSION_TOKEN_BUDGET_DEFAULT as BUDGET


async def poll(fn):
    for _ in range(50):
        result = await fn()
        if result is not None:
            return result
        await asyncio.sleep(0.02)
    raise AssertionError("condition never settled")


async def test_health_and_state_boot(client):
    health = (await client.get("/health")).json()
    assert health["status"] == "ok" and health["tier"] == "fake"
    assert health["model"] == "ok"
    state = (await client.get("/state")).json()
    assert len(state["keepers"]) == 3
    assert state["dream"] == {"latest_run_id": None, "running": False}
    assert state["keepers"][0]["session"]["status"] == "rested"


async def test_health_degrades_when_model_is_down(library, offline_lookups, monkeypatch):
    import httpx
    from mk_models import ModelGateway

    class DownGateway(ModelGateway):
        def __init__(self):
            super().__init__(tier="fake")

        async def probe(self):
            return False

    app = create_app(library=library, gateway=DownGateway(), lookups=offline_lookups)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        health = (await c.get("/health")).json()
    assert health["status"] == "degraded" and health["model"] == "down"


async def test_world_header_required(client):
    r = await client.get("/state", headers={"X-World": ""})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
    r = await client.get("/state", headers={"X-World": "w-1/keepers/x"})
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


async def test_chat_log_replays_the_conversation(client):
    await client.post("/keepers/dreams/tell", json={"text": "I dreamed of a slow train."})
    turns = (await client.get("/keepers/dreams/chat")).json()["turns"]
    assert [t["role"] for t in turns] == ["user", "keeper"]
    assert turns[0]["text"] == "I dreamed of a slow train."
    assert (await client.get("/keepers/nope/chat")).status_code == 404


async def test_say_routes_to_tell_or_ask(client):
    told = (await client.post("/keepers/dreams/say",
                              json={"text": "I dreamed of a red kite over the bay."})).json()
    assert told["kind"] == "tell" and told["book"]["source"] == "told"

    asked = (await client.post("/keepers/dreams/say",
                               json={"text": "what did I dream about the kite?"})).json()
    assert asked["kind"] == "ask" and asked["grounded"] and asked["sources"]


async def test_chatter_and_monument(client):
    assert (await client.get("/keepers/music/chatter")).json() == {"line": None}  # no dreaming yet
    out = (await client.post("/monument", json={"text": "I want a new keeper for recipes"})).json()
    assert out["created_keeper"]["topic"] == "recipes"


async def test_needs_sleep_gate_and_tired_dream(client, library):
    await client.get("/state")  # creates the world
    library.meter_add("w-test", "books", int(BUDGET * 0.9))
    r = await client.post("/keepers/books/tell", json={"text": "quick note"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "NEEDS_SLEEP"


async def test_sleep_compacts_and_frees(client, library):
    await client.post("/keepers/music/ask", json={"question": "what songs do I keep?"})
    for i in range(2):
        await client.post("/keepers/music/tell", json={"text": f"Song number {i} stays."})
    job = (await client.post("/keepers/music/sleep")).json()
    assert job["status"] == "running"

    async def done():
        data = (await client.get(f"/keepers/music/sleep/{job['job_id']}")).json()
        return data if data["status"] != "running" else None

    finished = await poll(done)
    assert finished["status"] == "done"
    sleep_books = [b for b in finished["books_written"] if b["source"] == "sleep"]
    assert len(sleep_books) == 1
    body = library.get_book("w-test", "music", sleep_books[0]["slug"]).body_md
    assert "what songs do I keep" in body and "Song number 0" not in body  # told books are on the shelf already
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


async def test_nightly_dreams_every_world(library, offline_lookups):
    from mk_agents import AgentsApi
    from mk_engine.events import DreamDispatcher
    from mk_models import ModelGateway
    library.ensure_world("w-a")
    library.ensure_world("w-b")
    agents = AgentsApi(library, ModelGateway(tier="fake"), offline_lookups)
    assert await DreamDispatcher(library, agents).nightly() == 2
    assert {library.dream_latest(w).status for w in ("w-a", "w-b")} == {"done"}


def test_nightly_clock():
    from datetime import datetime, time
    from mk_engine.events import parse_clock, seconds_until
    assert parse_clock("03:00") == time(3, 0) and parse_clock(" ") is None
    with pytest.raises(ValueError):
        parse_clock("3am")
    assert seconds_until(time(3, 0), datetime(2026, 10, 24, 2, 0)) == 3600
    assert seconds_until(time(3, 0), datetime(2026, 10, 24, 3, 0)) == 86400


async def test_dev_seed_reports_demo_content(client):
    data = (await client.post("/dev/seed")).json()
    assert data["seeded"] and data["keepers"] == 3 and data["books"] > 0


async def test_dev_routes_gated(client, library, monkeypatch, offline_lookups):
    assert (await client.post("/dev/reset")).status_code in (404, 405)
    monkeypatch.setenv("DEV_ROUTES", "1")
    import httpx
    from mk_models import ModelGateway
    dev_app = create_app(library=library, gateway=ModelGateway(tier="fake"),
                         lookups=offline_lookups)
    transport = httpx.ASGITransport(app=dev_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t",
                                 headers={"X-World": "w-dev"}) as dev_client:
        assert (await dev_client.get("/state")).json()["keepers"]
        assert (await dev_client.post("/dev/reset")).json()["reset"] is True


async def test_access_code_gates_the_api_before_any_model_call(library, monkeypatch, offline_lookups):
    import httpx
    from mk_engine import create_app
    from mk_models import ModelGateway

    monkeypatch.setenv("ACCESS_CODE", "island-key")
    app = create_app(library=library, gateway=ModelGateway(tier="fake"),
                     lookups=offline_lookups)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://t",
                                 headers={"X-World": "w-test"}) as c:
        denied = await c.get("/state")
        assert denied.status_code == 401
        assert denied.json()["error"]["code"] == "ACCESS_REQUIRED"
        assert (await c.get("/health")).status_code == 200
        ok = await c.get("/state", headers={"X-Access-Code": "island-key"})
        assert ok.status_code == 200


async def test_world_travel_export_import(client):
    r = await client.get("/world/export")
    assert r.status_code == 200
    data = r.json()
    assert data["format"] == "memory-keepers-world" and data["keepers"]

    r = await client.post("/world/import", json=data)
    assert r.status_code == 201
    body = r.json()
    assert body["world"].startswith("w-") and body["keepers"] > 0

    r = await client.get("/state", headers={"X-World": body["world"]})
    assert r.status_code == 200 and len(r.json()["keepers"]) == body["keepers"]

    r = await client.post("/world/import", json={"format": "something-else"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "IMPORT_INVALID"
