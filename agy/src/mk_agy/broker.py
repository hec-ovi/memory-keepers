"""The model-job broker: a tiny in-memory queue between the island's model
gateway (producer) and a serving CLI attached through the MCP toolkit
(consumer). One process, no store: jobs live only while both sides are up."""
import asyncio
import uuid

from fastapi import FastAPI
from pydantic import BaseModel

WAIT_CAP_S = 30


class JobIn(BaseModel):
    prompt: str


class ReplyIn(BaseModel):
    text: str


class Job:
    def __init__(self, prompt: str):
        self.id = "j-" + uuid.uuid4().hex[:12]
        self.prompt = prompt
        self.status = "pending"  # pending -> claimed -> done
        self.reply: str | None = None
        self.done = asyncio.Event()


def create_broker() -> FastAPI:
    app = FastAPI(title="mk-agy-broker")
    jobs: dict[str, Job] = {}
    queue: asyncio.Queue[str] = asyncio.Queue()

    @app.get("/health")
    async def health():
        return {"status": "ok", "pending": queue.qsize()}

    @app.post("/jobs", status_code=201)
    async def submit(body: JobIn):
        job = Job(body.prompt)
        jobs[job.id] = job
        await queue.put(job.id)
        return {"job_id": job.id}

    @app.get("/jobs/next")
    async def claim(wait: float = WAIT_CAP_S):
        try:
            job_id = await asyncio.wait_for(queue.get(), timeout=min(wait, WAIT_CAP_S))
        except TimeoutError:
            return {"idle": True}
        job = jobs[job_id]
        job.status = "claimed"
        return {"job_id": job.id, "prompt": job.prompt}

    @app.get("/jobs/{job_id}")
    async def poll(job_id: str, wait: float = 0):
        job = jobs.get(job_id)
        if not job:
            return {"status": "unknown"}
        if wait and not job.done.is_set():
            try:
                await asyncio.wait_for(job.done.wait(), timeout=min(wait, WAIT_CAP_S))
            except TimeoutError:
                pass
        return {"status": job.status, "reply": job.reply}

    @app.post("/jobs/{job_id}/reply")
    async def reply(job_id: str, body: ReplyIn):
        job = jobs.get(job_id)
        if not job:
            return {"ok": False, "reason": "unknown_job"}
        job.reply = body.text
        job.status = "done"
        job.done.set()
        return {"ok": True}

    return app


app = create_broker()
