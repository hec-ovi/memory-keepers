"""The HTTP surface. Routes per engine/CONTRACT.md; world scoping via X-World;
statics for the frontend; no model or Firestore access outside agents/library."""
import os
import secrets
from pathlib import Path

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from mk_agents import AgentsApi
from mk_lookups import LookupsApi
from mk_library import Library, LibraryError, seed
from mk_library.limits import NEEDS_SLEEP_THRESHOLD, SESSION_TOKEN_BUDGET_DEFAULT
from mk_models import ModelGateway

from .events import DreamDispatcher
from .sleep import start_sleep_job

VERSION = "0.9"
ERROR_STATUS = {
    "WORLD_NOT_FOUND": 404, "KEEPER_NOT_FOUND": 404, "BOOK_NOT_FOUND": 404,
    "DREAM_NOT_FOUND": 404, "SLEEP_NOT_FOUND": 404,
    "KEEPER_EXISTS": 409, "KEEPERS_FULL": 409, "LIBRARY_FULL": 409,
    "NEEDS_SLEEP": 409, "SLEEP_RUNNING": 409, "DREAM_RUNNING": 409,
    "VALIDATION": 422, "IMPORT_INVALID": 422,
}


class ApiError(Exception):
    def __init__(self, code: str, message: str = ""):
        self.code = code
        super().__init__(message or code)


def create_app(library: Library | None = None, gateway: ModelGateway | None = None,
               lookups: LookupsApi | None = None) -> FastAPI:
    library = library or Library(seed=seed.apply)
    gateway = gateway or ModelGateway()
    agents_api = AgentsApi(library, gateway, lookups or LookupsApi())
    dispatcher = DreamDispatcher(library, agents_api)
    budget = int(os.environ.get("SESSION_TOKEN_BUDGET", SESSION_TOKEN_BUDGET_DEFAULT))
    dev_routes = os.environ.get("DEV_ROUTES") == "1"

    app = FastAPI(title="memory-keepers", version=VERSION)

    # The island key: with ACCESS_CODE set, the API answers only callers who
    # carry it, so anonymous traffic never reaches a model or speech service.
    # Statics and /health stay open; /internal has its own token gate.
    access_code = os.environ.get("ACCESS_CODE")
    GATED = ("/state", "/keepers", "/monument", "/dream", "/voice", "/dev", "/world")

    @app.middleware("http")
    async def gate_access(request: Request, call_next):
        if (access_code and request.url.path.startswith(GATED)
                and request.headers.get("X-Access-Code") != access_code):
            return JSONResponse(status_code=401, content={"error": {
                "code": "ACCESS_REQUIRED", "message": "this island asks for its key"}})
        return await call_next(request)

    @app.exception_handler(LibraryError)
    @app.exception_handler(ApiError)
    async def on_error(request: Request, exc):
        return JSONResponse(
            status_code=ERROR_STATUS.get(exc.code, 500),
            content={"error": {"code": exc.code, "message": str(exc)}})

    def world_of(x_world: str | None) -> str:
        if not x_world or not x_world.strip():
            raise ApiError("VALIDATION", "X-World header is required")
        wid = x_world.strip()[:64]
        library.ensure_world(wid)  # idempotent; re-seeds if the store was wiped
        return wid

    def keeper_payload(world: str, kid: str) -> dict:
        return library.get_keeper(world, kid).payload(budget)

    def sleeping(keeper) -> bool:
        return bool(keeper.sleep_job and keeper.sleep_job.get("status") == "running")

    def keeper_tired(world: str, kid: str):
        keeper = library.get_keeper(world, kid)
        return keeper, keeper.tokens_used >= budget * NEEDS_SLEEP_THRESHOLD

    def dream_running(world: str, meta: dict) -> bool:
        try:
            return bool(meta.get("latest_run_id")
                        and library.dream_latest(world).status in ("queued", "running"))
        except LibraryError:
            meta["latest_run_id"] = None
            return False

    def gate_chat(world: str, kid: str) -> None:
        keeper, tired = keeper_tired(world, kid)
        if sleeping(keeper):
            raise ApiError("SLEEP_RUNNING", "she is asleep right now")
        if tired:
            raise ApiError("NEEDS_SLEEP", "she needs to sleep before talking more")

    async def check_tired(world: str, kid: str) -> None:
        _, tired = keeper_tired(world, kid)
        if tired:
            await dispatcher.dispatch(world, f"tired-keeper:{kid}")

    # -- health and state ------------------------------------------------------
    @app.get("/health")
    async def health():
        model_ok = await gateway.probe()
        return {"status": "ok" if model_ok else "degraded", "version": VERSION,
                "tier": gateway.tier(), "model": "ok" if model_ok else "down"}

    @app.get("/state")
    async def state(x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        meta = library.world_meta(world)
        running = dream_running(world, meta)
        return {"keepers": [k.payload(budget) for k in library.list_keepers(world)],
                "dream": {"latest_run_id": meta.get("latest_run_id"), "running": running}}

    # -- keepers ---------------------------------------------------------------
    @app.post("/keepers", status_code=201)
    async def create_keeper(body: dict, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        topic = str(body.get("topic", "")).strip()
        if not topic:
            raise ApiError("VALIDATION", "topic is required")
        keeper = library.create_keeper(
            world, topic, name=body.get("name"), persona=body.get("persona"))
        return keeper.payload(budget)

    @app.get("/keepers")
    async def list_keepers(x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        return [k.payload(budget) for k in library.list_keepers(world)]

    @app.get("/keepers/{kid}")
    async def get_keeper(kid: str, x_world: str | None = Header(default=None)):
        return keeper_payload(world_of(x_world), kid)

    @app.delete("/keepers/{kid}")
    async def delete_keeper(kid: str, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        keeper = library.get_keeper(world, kid)
        if sleeping(keeper):
            raise ApiError("SLEEP_RUNNING", "she is asleep right now")
        library.delete_keeper(world, kid)
        return {"deleted": True}

    # -- chat --------------------------------------------------------------
    @app.post("/keepers/{kid}/say")
    async def say(kid: str, body: dict, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        text = str(body.get("text", "")).strip()
        if not text:
            raise ApiError("VALIDATION", "text is required")
        gate_chat(world, kid)
        out = await agents_api.keeper_say(world, kid, text)
        await check_tired(world, kid)
        return out | {"session": keeper_payload(world, kid)["session"]}

    @app.post("/keepers/{kid}/tell")
    async def tell(kid: str, body: dict, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        text = str(body.get("text", "")).strip()
        if not text:
            raise ApiError("VALIDATION", "text is required")
        gate_chat(world, kid)
        out = await agents_api.keeper_tell(world, kid, text)
        await check_tired(world, kid)
        return out | {"session": keeper_payload(world, kid)["session"]}

    @app.post("/keepers/{kid}/ask")
    async def ask(kid: str, body: dict, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        question = str(body.get("question", "")).strip()
        if not question:
            raise ApiError("VALIDATION", "question is required")
        gate_chat(world, kid)
        out = await agents_api.keeper_ask(world, kid, question)
        await check_tired(world, kid)
        return out | {"session": keeper_payload(world, kid)["session"]}

    @app.get("/keepers/{kid}/chatter")
    async def chatter(kid: str, x_world: str | None = Header(default=None)):
        return {"line": agents_api.keeper_chatter(world_of(x_world), kid)}

    @app.get("/keepers/{kid}/chat")
    async def chat(kid: str, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        library.get_keeper(world, kid)  # 404 for unknown keepers
        session = library.session_read(world, kid)
        return {"turns": [{"t": t.t, "role": t.role, "text": t.text}
                          for t in session.turns]}

    @app.post("/monument")
    async def monument(body: dict, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        text = str(body.get("text", "")).strip()
        if not text:
            raise ApiError("VALIDATION", "text is required")
        return await agents_api.monument_chat(world, text)

    # -- books --------------------------------------------------------------
    @app.get("/keepers/{kid}/books")
    async def books(kid: str, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        library.get_keeper(world, kid)
        return [b.summary() for b in library.list_books(world, kid)]

    @app.get("/keepers/{kid}/books/{slug}")
    async def book(kid: str, slug: str, x_world: str | None = Header(default=None)):
        return library.get_book(world_of(x_world), kid, slug).payload()

    @app.delete("/keepers/{kid}/books/{slug}")
    async def delete_book(kid: str, slug: str, x_world: str | None = Header(default=None)):
        library.delete_book(world_of(x_world), kid, slug)
        return {"deleted": True}

    # -- sleep --------------------------------------------------------------
    @app.post("/keepers/{kid}/sleep", status_code=202)
    async def sleep(kid: str, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        keeper = library.get_keeper(world, kid)
        if sleeping(keeper):
            raise ApiError("SLEEP_RUNNING", "she is already asleep")
        return {"job_id": start_sleep_job(library, world, kid), "status": "running"}

    @app.get("/keepers/{kid}/sleep/{job_id}")
    async def sleep_job(kid: str, job_id: str, x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        keeper = library.get_keeper(world, kid)
        job = keeper.sleep_job
        if not job or job.get("job_id") != job_id:
            raise ApiError("SLEEP_NOT_FOUND", job_id)
        return job | {"keeper_id": kid, "session": keeper.payload(budget)["session"]}

    # -- dreaming ----------------------------------------------------------
    @app.post("/dream", status_code=202)
    async def dream(x_world: str | None = Header(default=None)):
        world = world_of(x_world)
        meta = library.world_meta(world)
        if dream_running(world, meta):
            raise ApiError("DREAM_RUNNING", "the island is already dreaming")
        run = library.dream_start(world, "asked", status="queued")
        await dispatcher.dispatch(world, "asked", run.run_id)
        return {"status": "queued", "run_id": run.run_id}

    @app.get("/dreams/latest")
    async def dream_latest(x_world: str | None = Header(default=None)):
        return library.dream_latest(world_of(x_world)).to_doc()

    @app.get("/dreams/{run_id}")
    async def dream_get(run_id: str, x_world: str | None = Header(default=None)):
        return library.dream_get(world_of(x_world), run_id).to_doc()

    # -- world travel -------------------------------------------------------
    @app.get("/world/export")
    async def world_export(x_world: str | None = Header(default=None)):
        return library.export_world(world_of(x_world))

    @app.post("/world/import", status_code=201)
    async def world_import(body: dict):
        wid = "w-" + secrets.token_hex(16)  # a fresh island; the file never carries its old id
        return {"world": wid} | library.import_world(wid, body)

    def _gate_internal(request: Request):
        token = os.environ.get("INTERNAL_TOKEN")
        if not token or request.query_params.get("token") != token:
            return JSONResponse(status_code=403, content={"error": {
                "code": "VALIDATION", "message": "bad token"}})
        return None

    @app.post("/internal/dream-run")
    async def dream_push(body: dict, request: Request):
        denied = _gate_internal(request)
        if denied:
            return denied
        report = await dispatcher.handle_push(body)
        return {"status": report["status"], "run_id": report["run_id"]}

    @app.post("/internal/nightly")
    async def nightly(request: Request):
        denied = _gate_internal(request)
        if denied:
            return denied
        worlds = library.list_worlds()
        for wid in worlds:
            await dispatcher.dispatch(wid, "nightly")
        return {"dispatched": len(worlds)}

    # -- voice and dev -----------------------------------------------------
    from mk_voice import create_voice_router, unavailable_router
    app.include_router(unavailable_router() if os.environ.get("VOICE") == "off"
                       else create_voice_router())

    @app.post("/dev/seed")
    async def dev_seed(x_world: str | None = Header(default=None)):
        world = world_of(x_world)  # first touch seeds demo content
        keepers = library.list_keepers(world)
        books = sum(k.book_count for k in keepers)
        return {"seeded": True, "keepers": len(keepers), "books": books}

    if dev_routes:
        @app.post("/dev/reset")
        async def dev_reset(x_world: str | None = Header(default=None)):
            library.delete_world(world_of(x_world))
            return {"reset": True}

    # engine/src/mk_engine/app.py -> repo root, so the mount works from any CWD
    frontend_dir = Path(__file__).resolve().parents[3] / "frontend"
    if frontend_dir.is_dir():

        class RevalidatingStatics(StaticFiles):
            """Statics revalidate on every load (no-cache + etag 304s): the SPA
            has no build step, so this is the only cache-busting there is."""

            def file_response(self, *args, **kwargs):
                response = super().file_response(*args, **kwargs)
                response.headers["Cache-Control"] = "no-cache"
                return response

        app.mount("/", RevalidatingStatics(directory=frontend_dir, html=True), name="frontend")

    return app
