import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApi, ApiError } from "../src/api/api.js";

const BASE = "http://engine.test";
const server = setupServer();
const noSleep = vi.fn(() => Promise.resolve());

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  noSleep.mockClear();
});
afterAll(() => server.close());

const api = () => createApi({ baseUrl: BASE, sleep: noSleep });

describe("envelope peeling", () => {
  it("peels bare JSON", async () => {
    server.use(http.get(`${BASE}/health`, () => HttpResponse.json({ status: "ok", version: "1" })));
    await expect(api().health()).resolves.toEqual({ status: "ok", version: "1" });
  });

  it("peels the SDK {ok, result} envelope", async () => {
    server.use(
      http.get(`${BASE}/keepers`, () => HttpResponse.json({ ok: true, result: [{ id: "dreams" }] })),
    );
    await expect(api().listKeepers()).resolves.toEqual([{ id: "dreams" }]);
  });

  it("peels the transport {success, data:{status, json}} envelope", async () => {
    server.use(
      http.get(`${BASE}/keepers/dreams`, () =>
        HttpResponse.json({ success: true, data: { status: 200, json: { id: "dreams" } } }),
      ),
    );
    await expect(api().getKeeper("dreams")).resolves.toEqual({ id: "dreams" });
  });

  it("peels nested envelopes (SDK wrapping transport)", async () => {
    server.use(
      http.get(`${BASE}/state`, () =>
        HttpResponse.json({
          ok: true,
          result: { success: true, data: { status: 200, json: { keepers: [] } } },
        }),
      ),
    );
    await expect(api().getState()).resolves.toEqual({ keepers: [], consolidation: { latest_run_id: null, running: false } });
  });

  it("maps an inner transport error status to ApiError even when HTTP is 200", async () => {
    server.use(
      http.get(`${BASE}/keepers/ghost`, () =>
        HttpResponse.json({
          success: true,
          data: { status: 404, json: { error: { code: "KEEPER_NOT_FOUND", message: "no such keeper" } } },
        }),
      ),
    );
    const err = await api().getKeeper("ghost").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: "KEEPER_NOT_FOUND", message: "no such keeper" });
  });

  it("maps {ok: false} envelopes to ApiError", async () => {
    server.use(
      http.get(`${BASE}/health`, () =>
        HttpResponse.json({ ok: false, error: { code: "HARNESS_ERROR", message: "sim exploded" } }),
      ),
    );
    const err = await api().health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("HARNESS_ERROR");
    expect(err.message).toBe("sim exploded");
  });
});

describe("ApiError mapping", () => {
  it("maps engine error bodies with HTTP status", async () => {
    server.use(
      http.post(`${BASE}/keepers`, () =>
        HttpResponse.json(
          { error: { code: "KEEPER_EXISTS", message: "keeper already exists" } },
          { status: 409 },
        ),
      ),
    );
    const err = await api().createKeeper({ topic: "dreams" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "KEEPER_EXISTS", message: "keeper already exists" });
  });

  it("maps error bodies without a code to a fallback", async () => {
    server.use(http.get(`${BASE}/health`, () => HttpResponse.json({}, { status: 400 })));
    const err = await api().health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("UNKNOWN");
  });

  it("maps network failures to ApiError{status: 0, code: NETWORK}", async () => {
    server.use(http.post(`${BASE}/consolidate`, () => HttpResponse.error()));
    const err = await api().consolidate().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("NETWORK");
  });
});

describe("retry policy", () => {
  it("retries GETs on 5xx and succeeds, with backoff sleeps", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/state`, () => {
        calls++;
        if (calls < 3) return HttpResponse.json({ error: { code: "X", message: "boom" } }, { status: 500 });
        return HttpResponse.json({ keepers: [] });
      }),
    );
    await expect(api().getState()).resolves.toEqual({ keepers: [], consolidation: { latest_run_id: null, running: false } });
    expect(calls).toBe(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenNthCalledWith(1, 250);
    expect(noSleep).toHaveBeenNthCalledWith(2, 500);
  });

  it("gives up after 4 total GET attempts", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/state`, () => {
        calls++;
        return HttpResponse.json({ error: { code: "X", message: "boom" } }, { status: 500 });
      }),
    );
    const err = await api().getState().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(calls).toBe(4); // 1 initial + 3 retries
  });

  it("does not retry GETs on 4xx", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/keepers/ghost`, () => {
        calls++;
        return HttpResponse.json({ error: { code: "KEEPER_NOT_FOUND", message: "nope" } }, { status: 404 });
      }),
    );
    await expect(api().getKeeper("ghost")).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("retries GETs on network failure", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/health`, () => {
        calls++;
        if (calls === 1) return HttpResponse.error();
        return HttpResponse.json({ status: "ok" });
      }),
    );
    await expect(api().health()).resolves.toEqual({ status: "ok" });
    expect(calls).toBe(2);
  });

  it("never retries POST", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/keepers/dreams/tell`, () => {
        calls++;
        return HttpResponse.json({ error: { code: "X", message: "boom" } }, { status: 500 });
      }),
    );
    await expect(api().tell("dreams", "hi")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("never retries DELETE", async () => {
    let calls = 0;
    server.use(
      http.delete(`${BASE}/keepers/dreams`, () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    await expect(api().deleteKeeper("dreams")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });
});

describe("wrapper methods", () => {
  it("sends JSON bodies for POST wrappers", async () => {
    let seen = null;
    server.use(
      http.post(`${BASE}/keepers/dreams/ask`, async ({ request }) => {
        seen = await request.json();
        return HttpResponse.json({ answer: "42", sources: [] });
      }),
    );
    await expect(api().ask("dreams", "meaning?")).resolves.toEqual({ answer: "42", sources: [] });
    expect(seen).toEqual({ question: "meaning?" });
  });

  it("URL-encodes ids and slugs", async () => {
    server.use(
      http.get(`${BASE}/keepers/dr%20eams/books/a%2Fb`, () => HttpResponse.json({ slug: "a/b" })),
    );
    await expect(api().getBook("dr eams", "a/b")).resolves.toEqual({ slug: "a/b" });
  });

  it("passes the round-5 grounding and session fields through untouched", async () => {
    const askBody = {
      answer: "when did that happen?",
      sources: [],
      grounded: false,
      followup: true,
    };
    const keeper = {
      id: "dreams",
      level: 4,
      session: { tokens_used: 120, budget: 4000, status: "rested" },
    };
    server.use(
      http.post(`${BASE}/keepers/dreams/ask`, () => HttpResponse.json(askBody)),
      http.get(`${BASE}/keepers/dreams`, () => HttpResponse.json(keeper)),
      http.post(`${BASE}/keepers/dreams/sleep`, () =>
        HttpResponse.json({ job_id: "job-7" }, { status: 202 }),
      ),
      http.get(`${BASE}/keepers/dreams/sleep/job-7`, () =>
        HttpResponse.json({ status: "running" }),
      ),
    );
    const a = api();
    await expect(a.ask("dreams", "q")).resolves.toEqual(askBody);
    await expect(a.getKeeper("dreams")).resolves.toEqual(keeper);
    await expect(a.sleep("dreams")).resolves.toEqual({ job_id: "job-7" });
    await expect(a.sleepJob("dreams", "job-7")).resolves.toEqual({ status: "running" });
  });

  it("surfaces 409 NEEDS_SLEEP and SLEEP_RUNNING as ApiError codes", async () => {
    server.use(
      http.post(`${BASE}/keepers/dreams/tell`, () =>
        HttpResponse.json(
          { error: { code: "NEEDS_SLEEP", message: "she must sleep first" } },
          { status: 409 },
        ),
      ),
      http.post(`${BASE}/keepers/dreams/sleep`, () =>
        HttpResponse.json(
          { error: { code: "SLEEP_RUNNING", message: "already dreaming" } },
          { status: 409 },
        ),
      ),
    );
    const a = api();
    await expect(a.tell("dreams", "x")).rejects.toMatchObject({
      status: 409,
      code: "NEEDS_SLEEP",
    });
    await expect(a.sleep("dreams")).rejects.toMatchObject({
      status: 409,
      code: "SLEEP_RUNNING",
    });
  });

  it("hits every endpoint path from docs/api.md", async () => {
    const hits = [];
    const record = (method, path, body) =>
      http[method](`${BASE}${path}`, ({ request }) => {
        hits.push(`${request.method} ${new URL(request.url).pathname}`);
        return HttpResponse.json(body ?? {});
      });
    server.use(
      record("get", "/health"),
      record("get", "/state"),
      record("post", "/keepers"),
      record("get", "/keepers", []),
      record("get", "/keepers/a"),
      record("delete", "/keepers/a"),
      record("post", "/keepers/a/tell"),
      record("post", "/keepers/a/ask"),
      record("get", "/keepers/a/books", []),
      record("get", "/keepers/a/books/b"),
      record("delete", "/keepers/a/books/b"),
      record("get", "/keepers/a/chatter", { line: "hi" }),
      record("post", "/keepers/a/sleep", { job_id: "j1" }),
      record("get", "/keepers/a/sleep/j1", { status: "done" }),
      record("post", "/dream"),
      record("get", "/dreams/latest"),
      record("get", "/dreams/run-1"),
      record("post", "/dev/seed"),
      record("post", "/dev/reset"),
    );
    const a = api();
    await a.health();
    await a.getState();
    await a.createKeeper({ topic: "t" });
    await a.listKeepers();
    await a.getKeeper("a");
    await a.deleteKeeper("a");
    await a.tell("a", "x");
    await a.ask("a", "q");
    await a.listBooks("a");
    await a.getBook("a", "b");
    await a.deleteBook("a", "b");
    await a.getChatter("a");
    await a.sleep("a");
    await a.sleepJob("a", "j1");
    await a.consolidate();
    await a.getLatestConsolidation();
    await a.getConsolidation("run-1");
    await a.seed();
    await a.reset();
    expect(hits).toEqual([
      "GET /health",
      "GET /state",
      "POST /keepers",
      "GET /keepers",
      "GET /keepers/a",
      "DELETE /keepers/a",
      "POST /keepers/a/tell",
      "POST /keepers/a/ask",
      "GET /keepers/a/books",
      "GET /keepers/a/books/b",
      "DELETE /keepers/a/books/b",
      "GET /keepers/a/chatter",
      "POST /keepers/a/sleep",
      "GET /keepers/a/sleep/j1",
      "POST /dream",
      "GET /dreams/latest",
      "GET /dreams/run-1",
      "POST /dev/seed",
      "POST /dev/reset",
    ]);
  });
});

describe("voice routes", () => {
  it("stt posts the blob with its own content type and resolves the transcription", async () => {
    let seen = null;
    server.use(
      http.post(`${BASE}/voice/stt`, async ({ request }) => {
        seen = {
          type: request.headers.get("content-type"),
          world: request.headers.get("x-world"),
          bytes: (await request.arrayBuffer()).byteLength,
        };
        return HttpResponse.json({ text: "hello island" });
      }),
    );
    const blob = new Blob(["opus"], { type: "audio/ogg;codecs=opus" });
    await expect(api().stt(blob)).resolves.toEqual({ text: "hello island" });
    expect(seen.type).toBe("audio/ogg;codecs=opus");
    expect(seen.world).toBeTruthy(); // voice carries X-World like every route
    expect(seen.bytes).toBeGreaterThan(0);
  });

  it("tts posts {text, kind} and resolves an audio Blob", async () => {
    let body = null;
    server.use(
      http.post(`${BASE}/voice/tts`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
          headers: { "content-type": "audio/ogg" },
        });
      }),
    );
    const out = await api().tts("hello", "dark");
    expect(body).toEqual({ text: "hello", kind: "dark" });
    expect(out).toBeInstanceOf(Blob);
    expect(out.size).toBe(3);
    expect(out.type).toContain("audio/ogg");
  });

  it("maps 503 on both routes to ApiError VOICE_UNAVAILABLE", async () => {
    const unavailable = () =>
      HttpResponse.json(
        { error: { code: "VOICE_UNAVAILABLE", message: "speech is not configured" } },
        { status: 503 },
      );
    server.use(http.post(`${BASE}/voice/stt`, unavailable), http.post(`${BASE}/voice/tts`, unavailable));
    const a = api();
    await expect(a.stt(new Blob(["x"], { type: "audio/webm" }))).rejects.toMatchObject({
      status: 503,
      code: "VOICE_UNAVAILABLE",
    });
    const err = await a.tts("hi").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: "VOICE_UNAVAILABLE" });
  });
});

describe("invoke transport", () => {
  it("calls invoke(path, {method, body}) and peels its envelopes", async () => {
    const invoke = vi.fn(async (path, { method }) => ({
      success: true,
      data: { status: 200, json: { echo: `${method} ${path}` } },
    }));
    const a = createApi({ invoke, sleep: noSleep });
    await expect(a.getKeeper("dreams")).resolves.toEqual({ echo: "GET /keepers/dreams" });
    expect(invoke).toHaveBeenCalledWith("/keepers/dreams", { method: "GET", body: undefined });

    await a.tell("dreams", "hello");
    expect(invoke).toHaveBeenCalledWith("/keepers/dreams/tell", {
      method: "POST",
      body: { text: "hello" },
    });
  });

  it("wins over baseUrl when both are provided", async () => {
    server.use(
      http.get(`${BASE}/health`, () => {
        throw new Error("fetch transport must not be used");
      }),
    );
    const invoke = vi.fn(async () => ({ ok: true, result: { status: "ok" } }));
    const a = createApi({ baseUrl: BASE, invoke, sleep: noSleep });
    await expect(a.health()).resolves.toEqual({ status: "ok" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("maps invoke error envelopes to ApiError", async () => {
    const invoke = async () => ({
      success: true,
      data: { status: 409, json: { error: { code: "CONSOLIDATION_RUNNING", message: "busy" } } },
    });
    const a = createApi({ invoke, sleep: noSleep });
    const err = await a.consolidate().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "CONSOLIDATION_RUNNING" });
  });

  it("retries GETs when invoke rejects, never POSTs", async () => {
    let getCalls = 0;
    let postCalls = 0;
    const invoke = async (path, { method }) => {
      if (method === "GET") {
        getCalls++;
        if (getCalls < 2) throw new Error("transport hiccup");
        return { keepers: [] };
      }
      postCalls++;
      throw new Error("transport hiccup");
    };
    const a = createApi({ invoke, sleep: noSleep });
    await expect(a.getState()).resolves.toEqual({ keepers: [], consolidation: { latest_run_id: null, running: false } });
    expect(getCalls).toBe(2);
    await expect(a.seed()).rejects.toMatchObject({ code: "NETWORK" });
    expect(postCalls).toBe(1);
  });
});
