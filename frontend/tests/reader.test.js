import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createBus } from "../src/bus.js";
import { createApi } from "../src/api/api.js";
import { createToasts } from "../src/ui/toasts.js";
import { createConfirm } from "../src/ui/confirm.js";
import { createReader, parseBookLink } from "../src/ui/reader.js";
import { BASE, dreamsKeeper, flyingBook, tideBook, makeState } from "./ui_fixtures.js";

const server = setupServer();
const noSleep = () => Promise.resolve();

let root, bus, state, toasts, confirm, reader;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  bus = createBus();
  state = makeState([dreamsKeeper()]);
  toasts = createToasts({ root });
  confirm = createConfirm({ root });
  const api = createApi({ baseUrl: BASE, sleep: noSleep });
  reader = createReader({ root, state, bus, api, toasts, confirm });
});

afterEach(() => {
  reader.dispose();
  confirm.dispose();
  toasts.dispose();
  root.remove();
  server.resetHandlers();
});

const serveBook = (book, keeperId = "dreams") =>
  http.get(`${BASE}/keepers/${keeperId}/books/${book.slug}`, () => HttpResponse.json(book));

describe("parseBookLink", () => {
  it("keeps bare slugs on the current keeper", () => {
    expect(parseBookLink("2026-07-01-the-tide", "dreams")).toEqual({
      keeperId: "dreams",
      slug: "2026-07-01-the-tide",
    });
  });

  it("splits cross-keeper links on the first slash", () => {
    expect(parseBookLink("meetings/2026-06-30-mars-sync", "dreams")).toEqual({
      keeperId: "meetings",
      slug: "2026-06-30-mars-sync",
    });
  });
});

describe("createReader", () => {
  it("injects the holo kit styles before its own so .mk-reader positioning wins the cascade", () => {
    // Regression: the kit's later-injected .holo-panel position rule used to
    // override .mk-reader's centering, dropping the reader into normal flow
    // (fully below the viewport whenever another panel was open).
    const ids = [...document.head.querySelectorAll("style")].map((s) => s.id);
    expect(ids).toContain("holo-kit-style");
    expect(ids).toContain("mk-reader-style");
    expect(ids.indexOf("holo-kit-style")).toBeLessThan(ids.indexOf("mk-reader-style"));
  });

  it("opens on book:open with title, meta chips and markdown body", async () => {
    server.use(serveBook(flyingBook()));
    bus.emit("book:open", { keeperId: "dreams", slug: flyingBook().slug });

    await screen.findByRole("heading", { name: "Flying over water" });
    expect(screen.getByText("2026-07-02")).toBeTruthy(); // date chip
    expect(screen.getByText("told")).toBeTruthy(); // source chip
    expect(screen.getByText("#flying")).toBeTruthy(); // tag chips
    expect(screen.getByText("#ocean")).toBeTruthy();
    expect(screen.getByText("Interstellar")).toBeTruthy(); // entity chips
    expect(screen.getByText("Mars")).toBeTruthy();
    // markdown body rendered as DOM, not text
    expect(screen.getByRole("heading", { name: "The night sky" })).toBeTruthy();
    const bold = screen.getByText("calm");
    expect(bold.tagName).toBe("STRONG");
  });

  it("clicking a link loads that book (cross-keeper links included)", async () => {
    const user = userEvent.setup();
    server.use(serveBook(flyingBook()), serveBook(tideBook()));
    bus.emit("book:open", { keeperId: "dreams", slug: flyingBook().slug });
    await screen.findByRole("heading", { name: "Flying over water" });

    await user.click(screen.getByRole("button", { name: "2026-07-01-the-tide" }));
    await screen.findByRole("heading", { name: "The tide" });
    expect(screen.queryByRole("heading", { name: "Flying over water" })).toBeNull();
  });

  it("destroy: cancel keeps the book and never calls DELETE", async () => {
    const user = userEvent.setup();
    let deletes = 0;
    server.use(
      serveBook(flyingBook()),
      http.delete(`${BASE}/keepers/dreams/books/${flyingBook().slug}`, () => {
        deletes++;
        return HttpResponse.json({ deleted: true });
      }),
    );
    bus.emit("book:open", { keeperId: "dreams", slug: flyingBook().slug });
    await screen.findByRole("heading", { name: "Flying over water" });

    await user.click(screen.getByRole("button", { name: "Destroy" }));
    const confirmDialog = screen.getByRole("dialog", { name: /destroy "flying over water"\?/i });
    await user.click(within(confirmDialog).getByRole("button", { name: "Cancel" }));

    expect(deletes).toBe(0);
    expect(screen.getByRole("heading", { name: "Flying over water" })).toBeTruthy();
    expect(reader.isOpen()).toBe(true);
  });

  it("destroy: confirm deletes, emits book:destroyed, closes, drops book_count", async () => {
    const user = userEvent.setup();
    let deletes = 0;
    server.use(
      serveBook(flyingBook()),
      http.delete(`${BASE}/keepers/dreams/books/${flyingBook().slug}`, () => {
        deletes++;
        return HttpResponse.json({ deleted: true });
      }),
    );
    const destroyed = vi.fn();
    bus.on("book:destroyed", destroyed);
    bus.emit("book:open", { keeperId: "dreams", slug: flyingBook().slug });
    await screen.findByRole("heading", { name: "Flying over water" });

    await user.click(screen.getByRole("button", { name: "Destroy" }));
    const confirmDialog = screen.getByRole("dialog", { name: /destroy "flying over water"\?/i });
    await user.click(within(confirmDialog).getByRole("button", { name: "Destroy" }));

    await waitFor(() =>
      expect(destroyed).toHaveBeenCalledWith({ keeperId: "dreams", slug: flyingBook().slug }),
    );
    expect(deletes).toBe(1);
    expect(reader.isOpen()).toBe(false);
    expect(screen.queryByRole("heading", { name: "Flying over water" })).toBeNull();
    expect(state.keepers[0].book_count).toBe(1); // was 2
  });

  it("destroy failure toasts and keeps the reader open", async () => {
    const user = userEvent.setup();
    server.use(
      serveBook(flyingBook()),
      http.delete(`${BASE}/keepers/dreams/books/${flyingBook().slug}`, () =>
        HttpResponse.json({ error: { code: "BOOK_NOT_FOUND", message: "already gone" } }, { status: 404 }),
      ),
    );
    bus.emit("book:open", { keeperId: "dreams", slug: flyingBook().slug });
    await screen.findByRole("heading", { name: "Flying over water" });
    await user.click(screen.getByRole("button", { name: "Destroy" }));
    await user.click(
      within(screen.getByRole("dialog", { name: /destroy/i })).getByRole("button", { name: "Destroy" }),
    );
    await screen.findByText("already gone"); // toast
    expect(reader.isOpen()).toBe(true);
    expect(state.keepers[0].book_count).toBe(2); // unchanged
  });

  it("fetch failure toasts and closes", async () => {
    server.use(
      http.get(`${BASE}/keepers/dreams/books/ghost`, () =>
        HttpResponse.json({ error: { code: "BOOK_NOT_FOUND", message: "no such book" } }, { status: 404 }),
      ),
    );
    bus.emit("book:open", { keeperId: "dreams", slug: "ghost" });
    await screen.findByText("no such book");
    expect(reader.isOpen()).toBe(false);
  });

  it("closes on Escape and via the close button", async () => {
    const user = userEvent.setup();
    server.use(serveBook(flyingBook()));
    bus.emit("book:open", { keeperId: "dreams", slug: flyingBook().slug });
    await screen.findByRole("heading", { name: "Flying over water" });
    await user.keyboard("{Escape}");
    expect(reader.isOpen()).toBe(false);

    bus.emit("book:open", { keeperId: "dreams", slug: flyingBook().slug });
    await screen.findByRole("heading", { name: "Flying over water" });
    await user.click(screen.getByRole("button", { name: /close reader/i }));
    expect(reader.isOpen()).toBe(false);
  });

  it("emits reader:closed when the panel closes (interior walks the keeper home)", async () => {
    const user = userEvent.setup();
    server.use(serveBook(flyingBook()));
    const closed = vi.fn();
    bus.on("reader:closed", closed);

    bus.emit("book:open", { keeperId: "dreams", slug: flyingBook().slug });
    await screen.findByRole("heading", { name: "Flying over water" });
    expect(closed).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /close reader/i }));
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
