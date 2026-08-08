import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createBus } from "../src/bus.js";
import { createApi } from "../src/api/api.js";
import { createToasts } from "../src/ui/toasts.js";
import { createHud } from "../src/ui/hud.js";
import { BASE, dreamsKeeper, meetingsKeeper, makeState, deferred } from "./ui_fixtures.js";

const server = setupServer();
const noSleep = () => Promise.resolve();

let root, bus, state, toasts, hud;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

function build(keepers) {
  root = document.createElement("div");
  document.body.appendChild(root);
  bus = createBus();
  state = makeState(keepers);
  toasts = createToasts({ root });
  const api = createApi({ baseUrl: BASE, sleep: noSleep });
  hud = createHud({ root, state, bus, api, toasts });
}

beforeEach(() => build([dreamsKeeper(), meetingsKeeper()])); // 2 keepers, 2+3 books

afterEach(() => {
  hud.dispose();
  toasts.dispose();
  root.remove();
  server.resetHandlers();
});

describe("createHud", () => {
  it("renders keeper and book counts from state", () => {
    expect(screen.getByText("2 keepers")).toBeTruthy();
    expect(screen.getByText("5 books")).toBeTruthy();
  });

  it("updates counts on book:created / book:destroyed / keeper:created", () => {
    state.keepers[0].book_count += 1;
    bus.emit("book:created", { keeperId: "dreams", book: {} });
    expect(screen.getByText("6 books")).toBeTruthy();

    state.keepers[0].book_count -= 1;
    bus.emit("book:destroyed", { keeperId: "dreams", slug: "x" });
    expect(screen.getByText("5 books")).toBeTruthy();

    bus.emit("keeper:created", { id: "films", topic: "films", book_count: 0 });
    expect(screen.getByText("3 keepers")).toBeTruthy();
    expect(state.keepers).toHaveLength(3);
  });

  it("Dreaming: calls the api, emits consolidation:started, disables until finished", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/dream`, () =>
        HttpResponse.json({ run_id: "run-9", status: "running" }, { status: 202 }),
      ),
    );
    const started = vi.fn();
    bus.on("consolidation:started", started);
    const btn = screen.getByRole("button", { name: "Dreaming" });
    expect(btn.disabled).toBe(false);

    await user.click(btn);
    await waitFor(() => expect(started).toHaveBeenCalledWith({ runId: "run-9" }));
    expect(btn.disabled).toBe(true);

    bus.emit("consolidation:finished", {});
    expect(btn.disabled).toBe(false);
  });

  it("Dreaming is disabled while the request is in flight", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    server.use(
      http.post(`${BASE}/dream`, async () => {
        await gate.promise;
        return HttpResponse.json({ run_id: "run-1", status: "running" }, { status: 202 });
      }),
    );
    const btn = screen.getByRole("button", { name: "Dreaming" });
    await user.click(btn);
    expect(btn.disabled).toBe(true);
    gate.resolve();
    await waitFor(() => expect(btn.disabled).toBe(true)); // still running afterwards
  });

  it("Dreaming is disabled when state:loaded reports a running consolidation", () => {
    const btn = screen.getByRole("button", { name: "Dreaming" });
    bus.emit("state:loaded", { state, consolidation: { running: true, latest_run_id: "run-3" } });
    expect(btn.disabled).toBe(true);
    bus.emit("report:loaded", {});
    expect(btn.disabled).toBe(false);
  });

  it("handles 409 CONSOLIDATION_RUNNING: warm toast + stays disabled", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/dream`, () =>
        HttpResponse.json(
          // The engine's 409 message speaks in consolidation words; the toast
          // must show the warm line instead, never this text.
          { error: { code: "CONSOLIDATION_RUNNING", message: "a consolidation run is already active" } },
          { status: 409 },
        ),
      ),
    );
    const btn = screen.getByRole("button", { name: "Dreaming" });
    await user.click(btn);
    await screen.findByText("they are already dreaming"); // warm toast
    expect(screen.queryByText("a consolidation run is already active")).toBeNull();
    expect(btn.disabled).toBe(true);
  });

  it("hides Demo data when keepers exist", () => {
    expect(screen.queryByRole("button", { name: "Demo data" })).toBeNull();
  });

  it("shows Demo data with zero keepers; seeding reloads state and hides it", async () => {
    hud.dispose();
    toasts.dispose();
    root.remove();
    build([]);

    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/dev/seed`, () => HttpResponse.json({ seeded: true, keepers: 2, books: 5 })),
      http.get(`${BASE}/state`, () =>
        HttpResponse.json({
          keepers: [dreamsKeeper(), meetingsKeeper()],
          consolidation: { latest_run_id: null, running: false },
        }),
      ),
    );
    const loaded = vi.fn();
    bus.on("state:loaded", loaded);

    expect(screen.getByText("0 keepers")).toBeTruthy();
    const seedBtn = screen.getByRole("button", { name: "Demo data" });
    await user.click(seedBtn);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Demo data" })).toBeNull());
    expect(screen.getByText("2 keepers")).toBeTruthy();
    expect(screen.getByText("5 books")).toBeTruthy();
    expect(state.keepers).toHaveLength(2);
    expect(loaded).toHaveBeenCalled();
  });

  it("View keepers emits keepers_list:open (the travel shortcut lives in that list now)", async () => {
    const user = userEvent.setup();
    const opened = vi.fn();
    const traveled = vi.fn();
    bus.on("keepers_list:open", opened);
    bus.on("district:travel", traveled);
    await user.click(screen.getByRole("button", { name: "View keepers" }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(traveled).not.toHaveBeenCalled(); // the HUD no longer travels directly
    expect(screen.queryByRole("button", { name: /visit the unconscious/i })).toBeNull();
  });

  it("action buttons carry tooltips", () => {
    for (const name of ["View keepers", "Create keeper", "Dreaming", "How to play"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.getAttribute("data-tooltip")).toBeTruthy();
    }
    expect(
      screen.getByRole("button", { name: /toggle sound/i }).getAttribute("data-tooltip"),
    ).toBeTruthy();
  });

  it("counters pop when their value changes, not on unrelated refreshes", () => {
    const bookStat = screen.getByText("5 books");
    const keeperStat = screen.getByText("2 keepers");
    expect(bookStat.classList.contains("stat-pop")).toBe(false);

    state.keepers[0].book_count += 1;
    bus.emit("book:created", { keeperId: "dreams", book: {} });
    expect(bookStat.classList.contains("stat-pop")).toBe(true);
    expect(keeperStat.classList.contains("stat-pop")).toBe(false); // unchanged count
  });

  it("mute toggle emits audio:mute with the new state", async () => {
    const user = userEvent.setup();
    const muted = vi.fn();
    bus.on("audio:mute", muted);
    const btn = screen.getByRole("button", { name: /toggle sound/i });
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    await user.click(btn);
    expect(muted).toHaveBeenLastCalledWith({ muted: true });
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    await user.click(btn);
    expect(muted).toHaveBeenLastCalledWith({ muted: false });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("Create keeper and How to play emit their bus events", async () => {
    const user = userEvent.setup();
    const create = vi.fn();
    const howto = vi.fn();
    bus.on("create_keeper:open", create);
    bus.on("howto:open", howto);
    await user.click(screen.getByRole("button", { name: "Create keeper" }));
    await user.click(screen.getByRole("button", { name: "How to play" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(howto).toHaveBeenCalledTimes(1);
  });
});
