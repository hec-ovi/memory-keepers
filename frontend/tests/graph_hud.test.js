import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createGraphHud, startConsolidationWatch } from "../src/ui/graph_hud.js";
import { createBus } from "../src/bus.js";
import { createApi } from "../src/api/api.js";

const BASE = "http://engine.test";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const makeReport = (status) => ({
  run_id: "run-9",
  status,
  started_at: "2026-07-02T02:00:00Z",
  finished_at: status === "running" ? null : "2026-07-02T02:03:00Z",
  created_keepers: [],
  created_books: [],
  graph: { nodes: [], edges: [] },
  narrative: "The dreaming found water running through everything you told them.",
});

describe("createGraphHud", () => {
  let root;
  let bus;
  let hud;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    bus = createBus();
  });

  afterEach(() => {
    hud?.dispose();
    hud = null;
    root.remove();
  });

  it("renders the run narrative under The Dreaming header", () => {
    hud = createGraphHud({ root, bus, report: makeReport("done") });
    expect(screen.getByText("The Dreaming")).toBeTruthy();
    expect(screen.getByText(/water running through everything/)).toBeTruthy();
  });

  it("shows a fallback line when the report has no narrative", () => {
    hud = createGraphHud({ root, bus, report: null });
    expect(screen.getByText(/left no note/)).toBeTruthy();
  });

  it("emits graph:skip when Skip is clicked", async () => {
    const user = userEvent.setup();
    hud = createGraphHud({ root, bus, report: makeReport("done") });
    const onSkip = vi.fn();
    bus.on("graph:skip", onSkip);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("emits graph:back when Back is clicked", async () => {
    const user = userEvent.setup();
    hud = createGraphHud({ root, bus, report: makeReport("done") });
    const onBack = vi.fn();
    bus.on("graph:back", onBack);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("tracks graph:progress on the wave progress indicator", () => {
    hud = createGraphHud({ root, bus, report: makeReport("done") });
    const bar = screen.getByRole("progressbar", { name: /assembly progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    bus.emit("graph:progress", { t: 0.42 });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    bus.emit("graph:progress", { t: 2 }); // clamped
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });

  it("completes the bar and hides Skip once the graph settles", () => {
    hud = createGraphHud({ root, bus, report: makeReport("done") });
    bus.emit("graph:settled", {});
    const bar = screen.getByRole("progressbar", { name: /assembly progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy(); // Back stays
  });

  it("dispose removes the overlay, its scoped style tag and bus listeners", () => {
    hud = createGraphHud({ root, bus, report: makeReport("done") });
    expect(document.querySelector(".keepergx-hud")).toBeTruthy();
    expect(document.querySelector("style[data-keepergx]")).toBeTruthy();
    hud.dispose();
    expect(document.querySelector(".keepergx-hud")).toBeNull();
    expect(document.querySelector("style[data-keepergx]")).toBeNull();
    expect(() => bus.emit("graph:progress", { t: 0.5 })).not.toThrow();
    hud = null;
  });
});

describe("startConsolidationWatch", () => {
  const noSleep = vi.fn(() => Promise.resolve());
  const api = () => createApi({ baseUrl: BASE, sleep: noSleep });

  function record(bus, events) {
    for (const name of ["consolidation:finished", "consolidation:failed", "toast"]) {
      bus.on(name, (payload) => events.push([name, payload]));
    }
  }

  it("polls running -> done with backoff and emits the report", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/dreams/run-9`, () => {
        calls++;
        return HttpResponse.json(makeReport(calls < 3 ? "running" : "done"));
      }),
    );
    const bus = createBus();
    const events = [];
    record(bus, events);
    const watchSleep = vi.fn(() => Promise.resolve());

    const watch = startConsolidationWatch({ api: api(), bus, runId: "run-9", sleep: watchSleep });
    const report = await watch.done;

    expect(calls).toBe(3);
    expect(report.status).toBe("done");
    expect(events).toEqual([["consolidation:finished", { report }]]);
    expect(events[0][1].report.narrative).toMatch(/water running/);
    // Backoff: 2500, then 2500 * 1.4.
    expect(watchSleep).toHaveBeenNthCalledWith(1, 2500);
    expect(watchSleep).toHaveBeenNthCalledWith(2, 3500);
  });

  it("emits a toast-style error and consolidation:failed when the run fails", async () => {
    server.use(
      http.get(`${BASE}/dreams/run-9`, () => HttpResponse.json(makeReport("failed"))),
    );
    const bus = createBus();
    const events = [];
    record(bus, events);

    const watch = startConsolidationWatch({ api: api(), bus, runId: "run-9" });
    const report = await watch.done;

    expect(report).toBeNull();
    const names = events.map(([name]) => name);
    expect(names).toContain("toast");
    expect(names).toContain("consolidation:failed");
    expect(names).not.toContain("consolidation:finished");
    const toast = events.find(([name]) => name === "toast")[1];
    expect(toast.kind).toBe("error");
    expect(toast.message).toMatch(/came apart/i); // warm copy, no "consolidation"
  });

  it("reports transport failures as an error toast instead of throwing", async () => {
    server.use(
      http.get(`${BASE}/dreams/run-9`, () =>
        HttpResponse.json({ error: { code: "HARNESS_ERROR", message: "sim exploded" } }, { status: 502 }),
      ),
    );
    const bus = createBus();
    const events = [];
    record(bus, events);

    const watch = startConsolidationWatch({ api: api(), bus, runId: "run-9" });
    await expect(watch.done).resolves.toBeNull();

    const toast = events.find(([name]) => name === "toast")[1];
    expect(toast.kind).toBe("error");
    expect(toast.message).toMatch(/sim exploded/);
    expect(events.map(([name]) => name)).toContain("consolidation:failed");
  });

  it("stop() halts polling without emitting anything", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/dreams/run-9`, () => {
        calls++;
        return HttpResponse.json(makeReport("running"));
      }),
    );
    const bus = createBus();
    const events = [];
    record(bus, events);

    let watch;
    const stoppingSleep = () => {
      watch.stop();
      return Promise.resolve();
    };
    watch = startConsolidationWatch({ api: api(), bus, runId: "run-9", sleep: stoppingSleep });
    await expect(watch.done).resolves.toBeNull();

    expect(calls).toBe(1);
    expect(events).toEqual([]);
  });

  it("works with an api exposing consolidation() instead of getConsolidation()", async () => {
    const bus = createBus();
    const events = [];
    record(bus, events);
    const fake = { consolidation: vi.fn(async () => makeReport("done")) };

    const watch = startConsolidationWatch({ api: fake, bus, runId: "run-9" });
    const report = await watch.done;

    expect(fake.consolidation).toHaveBeenCalledWith("run-9");
    expect(report.status).toBe("done");
    expect(events[0][0]).toBe("consolidation:finished");
  });
});
