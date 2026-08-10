import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createBus } from "../src/bus.js";
import { createApi } from "../src/api/api.js";
import { createToasts } from "../src/ui/toasts.js";
import { createCreateKeeper, slugify } from "../src/ui/create_keeper.js";
import { BASE, makeState, deferred } from "./ui_fixtures.js";

const server = setupServer();
const noSleep = () => Promise.resolve();

let root, bus, state, toasts, creator;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  bus = createBus();
  state = makeState([]);
  toasts = createToasts({ root });
  const api = createApi({ baseUrl: BASE, sleep: noSleep });
  creator = createCreateKeeper({ root, state, bus, api, toasts });
});

afterEach(() => {
  creator.dispose();
  toasts.dispose();
  root.remove();
  server.resetHandlers();
});

describe("slugify", () => {
  it("lowercases, kebab-cases and strips accents", () => {
    expect(slugify("  My  Dreams!! ")).toBe("my-dreams");
    expect(slugify("Café & Films")).toBe("cafe-films");
    expect(slugify("---")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("createCreateKeeper", () => {
  it("opens on create_keeper:open with submit disabled until the topic slugs", async () => {
    const user = userEvent.setup();
    bus.emit("create_keeper:open");
    const submit = screen.getByRole("button", { name: "Create" });
    expect(submit.disabled).toBe(true);

    const topic = screen.getByLabelText("Topic");
    await user.type(topic, "My Dreams!");
    expect(screen.getByText("my-dreams")).toBeTruthy(); // live slug preview
    expect(submit.disabled).toBe(false);

    await user.clear(topic);
    expect(submit.disabled).toBe(true);
    await user.type(topic, "!!!"); // slugs to nothing
    expect(submit.disabled).toBe(true);
  });

  it("creates a keeper: emits keeper:created, pushes to state, toasts, closes", async () => {
    const user = userEvent.setup();
    let sent = null;
    const keeper = { id: "night-walks", name: "Keeper of Night Walks", topic: "night-walks", kind: "conscious", book_count: 0 };
    server.use(
      http.post(`${BASE}/keepers`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(keeper, { status: 201 });
      }),
    );
    const created = vi.fn();
    bus.on("keeper:created", created);
    creator.open();

    await user.type(screen.getByLabelText("Topic"), "Night Walks");
    await user.type(screen.getByLabelText("Name (optional)"), "Keeper of Night Walks");
    await user.type(screen.getByLabelText("Persona (optional)"), "Keeper of midnight strolls.");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(creator.isOpen()).toBe(false));
    expect(sent).toEqual({
      topic: "night-walks",
      name: "Keeper of Night Walks",
      persona: "Keeper of midnight strolls.",
    });
    expect(created).toHaveBeenCalledWith(keeper);
    expect(state.keepers).toContainEqual(keeper);
    expect(screen.getByText(/keeper of night walks moved in/i)).toBeTruthy(); // toast
  });

  it("omits empty optional fields from the request body", async () => {
    const user = userEvent.setup();
    let sent = null;
    server.use(
      http.post(`${BASE}/keepers`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ id: "films", topic: "films" }, { status: 201 });
      }),
    );
    creator.open();
    await user.type(screen.getByLabelText("Topic"), "Films");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(creator.isOpen()).toBe(false));
    expect(sent).toEqual({ topic: "films" });
  });

  it("shows the 409 KEEPER_EXISTS error inline and stays open", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers`, () =>
        HttpResponse.json(
          { error: { code: "KEEPER_EXISTS", message: "keeper already exists" } },
          { status: 409 },
        ),
      ),
    );
    const created = vi.fn();
    bus.on("keeper:created", created);
    creator.open();

    await user.type(screen.getByLabelText("Topic"), "dreams");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await screen.findByText("keeper already exists");
    expect(creator.isOpen()).toBe(true);
    expect(created).not.toHaveBeenCalled();
    expect(state.keepers).toHaveLength(0);

    // typing again clears the inline error
    await user.type(screen.getByLabelText("Topic"), "-again");
    expect(screen.queryByText("keeper already exists")).toBeNull();
  });

  it("shows a friendly inline message on 409 KEEPERS_FULL (no free plots)", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers`, () =>
        HttpResponse.json(
          { error: { code: "KEEPERS_FULL", message: "all 16 conscious plots are taken" } },
          { status: 409 },
        ),
      ),
    );
    const created = vi.fn();
    bus.on("keeper:created", created);
    creator.open();

    await user.type(screen.getByLabelText("Topic"), "gardening");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await screen.findByText(/the village has no free plots yet/i);
    expect(creator.isOpen()).toBe(true);
    expect(created).not.toHaveBeenCalled();
    expect(state.keepers).toHaveLength(0);
  });

  it("disables submit while the request is in flight", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    server.use(
      http.post(`${BASE}/keepers`, async () => {
        await gate.promise;
        return HttpResponse.json({ id: "x", topic: "x" }, { status: 201 });
      }),
    );
    creator.open();
    await user.type(screen.getByLabelText("Topic"), "x");
    const submit = screen.getByRole("button", { name: "Create" });
    await user.click(submit);
    expect(submit.disabled).toBe(true);
    gate.resolve();
    await waitFor(() => expect(creator.isOpen()).toBe(false));
  });

  it("closes on Escape and on Cancel without creating anything", async () => {
    const user = userEvent.setup();
    creator.open();
    expect(creator.isOpen()).toBe(true);
    await user.keyboard("{Escape}");
    expect(creator.isOpen()).toBe(false);

    creator.open();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(creator.isOpen()).toBe(false);
    expect(state.keepers).toHaveLength(0);
  });
});
