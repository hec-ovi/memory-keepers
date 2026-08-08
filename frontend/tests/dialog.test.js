// Pins the dialog contract through the DOM with a mocked engine (MSW):
// tell shelves a book, ask shows grounded chips, tiredness offers sleep,
// holo panels open and close.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createApi } from "../src/api/api.js";
import { Dialog } from "../src/ui/dialog.js";
import { holoPanel } from "../src/ui/holo.js";

const keeper = {
  id: "dreams", name: "Keeper of Dreams", side: "light", level: 2,
  palette: { primary: "#7c6cf0" },
  session: { tokens_used: 100, budget: 12000, status: "rested" },
};

const server = setupServer(
  http.post("http://api/keepers/dreams/tell", () => HttpResponse.json({
    reply: "It is on the shelf now.",
    book: { slug: "2026-08-08-the-red-door", title: "The red door", tier: "small" },
    session: { tokens_used: 400, budget: 12000, status: "rested" },
  })),
  http.post("http://api/keepers/dreams/ask", () => HttpResponse.json({
    answer: "On 2026-08-02 you told me about the elevator.",
    sources: [{ slug: "2026-08-02-the-glass-elevator", title: "The glass elevator" }],
    grounded: true, followup: false,
    session: { tokens_used: 500, budget: 12000, status: "rested" },
  })),
  http.post("http://api/keepers/tired/tell", () => HttpResponse.json(
    { error: { code: "NEEDS_SLEEP", message: "tired" } }, { status: 409 })),
  http.post("http://api/keepers/tired/sleep", () => HttpResponse.json(
    { job_id: "sleep-1", status: "running" }, { status: 202 })),
);

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  document.body.innerHTML = "";
});
afterAll(() => server.close());

function makeDialog() {
  document.body.innerHTML = '<div id="panels"></div>';
  const api = createApi({ baseUrl: "http://api", worldId: "w-1" });
  return new Dialog({ api, root: document.getElementById("panels") });
}

describe("dialog", () => {
  it("tell mode shelves a book and shows its chip", async () => {
    const dialog = makeDialog();
    dialog.openKeeper(keeper);
    await userEvent.click(screen.getByText("tell her a memory"));
    await userEvent.type(screen.getByLabelText("message"), "The red door again.{Enter}");
    await waitFor(() => screen.getByText("It is on the shelf now."));
    expect(screen.getByText("📖 The red door")).toBeTruthy();
  });

  it("ask mode renders the grounded sources", async () => {
    const dialog = makeDialog();
    dialog.openKeeper(keeper);
    await userEvent.type(screen.getByLabelText("message"), "the elevator?{Enter}");
    await waitFor(() => screen.getByText(/you told me about the elevator/));
    expect(screen.getByText("📖 The glass elevator")).toBeTruthy();
  });

  it("NEEDS_SLEEP offers the sleep action", async () => {
    const dialog = makeDialog();
    dialog.openKeeper({ ...keeper, id: "tired", name: "Tired one",
      session: { tokens_used: 11000, budget: 12000, status: "needs_sleep" } });
    await userEvent.click(screen.getByText("tell her a memory"));
    await userEvent.type(screen.getByLabelText("message"), "hello{Enter}");
    await waitFor(() => screen.getByText("send her to sleep"));
    await userEvent.click(screen.getByText("send her to sleep"));
    await waitFor(() => screen.getByText(/walks home to sleep/));
  });

  it("dark keepers get no tell mode", () => {
    const dialog = makeDialog();
    dialog.openKeeper({ ...keeper, side: "dark", name: "The one who waits" });
    expect(screen.queryByText("tell her a memory")).toBeNull();
    expect(screen.getByText(/born from your dreaming/)).toBeTruthy();
  });
});

describe("holo kit", () => {
  it("opens with a title and closes on demand", async () => {
    document.body.innerHTML = '<div id="panels"></div>';
    const panel = holoPanel({ title: "test panel", root: document.getElementById("panels") });
    expect(screen.getByText("test panel")).toBeTruthy();
    await userEvent.click(screen.getByLabelText("close"));
    panel.el.dispatchEvent(new Event("animationend"));
    expect(screen.queryByText("test panel")).toBeNull();
  });
});
