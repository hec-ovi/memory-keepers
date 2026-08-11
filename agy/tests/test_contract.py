"""Contract of the agy box: the broker's job lifecycle and the MCP toolkit's
two verbs, all in-process (ASGI transport, no network)."""
import asyncio

import httpx
import pytest

from mk_agy import create_broker
from mk_agy.mcp_server import next_job, send_reply


@pytest.fixture
async def client():
    app = create_broker()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://b") as c:
        yield c


async def test_job_lifecycle_submit_claim_reply_poll(client):
    submitted = await client.post("/jobs", json={"prompt": "write a haiku"})
    job_id = submitted.json()["job_id"]
    assert submitted.status_code == 201 and job_id.startswith("j-")

    claimed = (await client.get("/jobs/next", params={"wait": 1})).json()
    assert claimed == {"job_id": job_id, "prompt": "write a haiku"}

    pending = (await client.get(f"/jobs/{job_id}")).json()
    assert pending == {"status": "claimed", "reply": None}

    assert (await client.post(f"/jobs/{job_id}/reply",
                              json={"text": "old pond, frog, splash"})).json() == {"ok": True}
    done = (await client.get(f"/jobs/{job_id}", params={"wait": 1})).json()
    assert done == {"status": "done", "reply": "old pond, frog, splash"}


async def test_claim_idles_when_no_work_and_unknown_jobs_answer(client):
    assert (await client.get("/jobs/next", params={"wait": 0.05})).json() == {"idle": True}
    assert (await client.get("/jobs/nope")).json() == {"status": "unknown"}
    assert (await client.post("/jobs/nope/reply", json={"text": "x"})).json() == {
        "ok": False, "reason": "unknown_job"}


async def test_poll_wait_blocks_until_the_reply_lands(client):
    job_id = (await client.post("/jobs", json={"prompt": "p"})).json()["job_id"]
    await client.get("/jobs/next", params={"wait": 1})

    async def answer_soon():
        await asyncio.sleep(0.05)
        await client.post(f"/jobs/{job_id}/reply", json={"text": "served"})

    answering = asyncio.ensure_future(answer_soon())
    polled = (await client.get(f"/jobs/{job_id}", params={"wait": 5})).json()
    await answering
    assert polled == {"status": "done", "reply": "served"}


def test_mcp_toolkit_verbs_speak_the_broker_protocol():
    calls = []

    class Res:
        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    class FakeClient:
        def get(self, path, params=None):
            calls.append(("GET", path, params))
            return Res({"job_id": "j-1", "prompt": "write a haiku"})

        def post(self, path, json=None):
            calls.append(("POST", path, json))
            return Res({"ok": True})

    assert next_job(FakeClient()) == {"job_id": "j-1", "prompt": "write a haiku"}
    assert send_reply(FakeClient(), "j-1", "old pond") == {"ok": True}
    assert calls == [("GET", "/jobs/next", {"wait": 30}),
                     ("POST", "/jobs/j-1/reply", {"text": "old pond"})]
