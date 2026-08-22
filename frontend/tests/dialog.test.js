import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createBus } from "../src/bus.js";
import { createApi } from "../src/api/api.js";
import { createToasts } from "../src/ui/toasts.js";
import {
  createDialog,
  MONUMENT_ID,
  restTone,
  bookSpineColor,
} from "../src/ui/dialog.js";
import { spineColorFromTags } from "../src/render/scene_interior.js";
import { BASE, dreamsKeeper, unconsciousKeeper, makeState, deferred } from "./ui_fixtures.js";

const server = setupServer();
const noSleep = () => Promise.resolve();

let root, bus, state, toasts, dialog;


beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

beforeEach(() => {
  // jsdom has no canvas backend; the voice viz and holo shards tolerate null.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  root = document.createElement("div");
  document.body.appendChild(root);
  bus = createBus();
  state = makeState([dreamsKeeper(), unconsciousKeeper()]);
  toasts = createToasts({ root });
  const api = createApi({ baseUrl: BASE, sleep: noSleep });
  dialog = createDialog({ root, state, bus, api, toasts, sleepPollMs: 5 });
  // every open replays her session log; tests that need turns override this
  server.use(http.get(`${BASE}/keepers/:id/chat`, () => HttpResponse.json({ turns: [] })));
});

afterEach(() => {
  dialog.dispose();
  toasts.dispose();
  root.remove();
  server.resetHandlers();
  vi.restoreAllMocks();
});

describe("createDialog", () => {
  it("opens on keeper:selected as a holo comm panel with name and accent; the topic chip stays off when the name already says it", () => {
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(screen.getByRole("heading", { name: "Keeper of Dreams" })).toBeTruthy();
    expect(screen.queryByText("dreams")).toBeNull();
    const panel = root.querySelector(".mk-dialog");
    expect(panel.classList.contains("holo-panel")).toBe(true);
    expect(panel.style.getPropertyValue("--mk-dialog-accent")).toBe("#7c4a6b");
    // the chat block is present and empty until something happens
    expect(root.querySelector(".mk-dialog-hist").children.length).toBe(0);
  });

  it("keeper:deselected leaves the panel open: clicking elsewhere never closes it", () => {
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(dialog.isOpen()).toBe(true);

    const closed = vi.fn();
    bus.on("ui:close", closed);
    bus.emit("keeper:deselected", { keeperId: "dreams" });
    expect(dialog.isOpen()).toBe(true);
    expect(root.querySelector(".mk-dialog")).not.toBeNull();
    expect(closed).not.toHaveBeenCalled();
  });

  it("replays the persistent conversation when the panel opens", async () => {
    server.use(
      http.get(`${BASE}/keepers/dreams/chat`, () =>
        HttpResponse.json({
          turns: [
            { t: "2026-08-19T10:00:00Z", role: "user", text: "hello there" },
            { t: "2026-08-19T10:00:01Z", role: "keeper", text: "It is kept." },
          ],
        }),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    expect(screen.getByText("It is kept.")).toBeTruthy();
  });

  it("a reply that lands while another panel is open stays out of it; her own history replays it", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const turns = [];
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, async () => {
        await gate.promise;
        turns.push({ role: "user", text: "hello" }, { role: "keeper", text: "late reply from dreams." });
        return HttpResponse.json({ reply: "late reply from dreams." });
      }),
      http.get(`${BASE}/keepers/dreams/chat`, () => HttpResponse.json({ turns })),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.type(
      screen.getByRole("textbox", { name: /speak to keeper of dreams/i }),
      "hello{Enter}",
    );
    // switch panels while she is still thinking
    bus.emit("keeper:selected", { keeperId: "still-water" });
    gate.resolve();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("late reply from dreams.")).toBeNull();
    expect(root.querySelector(".mk-dialog-hist").children.length).toBe(0);
    // back to her: the session log replays both rows, instantly, nothing pending
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await screen.findByText("late reply from dreams.");
    expect(screen.getByText("hello")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: /speak to keeper of dreams/i });
    expect(input.disabled).toBe(false);
    expect(input.closest("form").classList.contains("holo-thinking")).toBe(false);
  });

  it("a reply in flight follows her: her reopened panel shows the sent row and the thinking border, and the reply lands there", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, async () => {
        await gate.promise;
        return HttpResponse.json({ reply: "late reply from dreams." });
      }),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.type(
      screen.getByRole("textbox", { name: /speak to keeper of dreams/i }),
      "hello{Enter}",
    );
    bus.emit("keeper:selected", { keeperId: "still-water" });
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const input = screen.getByRole("textbox", { name: /speak to keeper of dreams/i });
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    expect(input.disabled).toBe(true);
    expect(input.closest("form").classList.contains("holo-thinking")).toBe(true);
    gate.resolve();
    await screen.findByText("late reply from dreams.");
    await waitFor(() => expect(input.closest("form").classList.contains("holo-thinking")).toBe(false));
    expect(input.disabled).toBe(false);
  });

  it("the main keeper's conversation lives in the page: switching away and back replays it", async () => {
    const user = userEvent.setup();
    server.use(http.post(`${BASE}/monument`, () => HttpResponse.json({ reply: "the island remembers." })));
    bus.emit("keeper:selected", { keeperId: MONUMENT_ID });
    await user.type(screen.getByRole("textbox", { name: /speak to memory keeper/i }), "who are you{Enter}");
    await screen.findByText("the island remembers.");
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(screen.queryByText("the island remembers.")).toBeNull();
    bus.emit("keeper:selected", { keeperId: MONUMENT_ID });
    expect(screen.getByText("who are you")).toBeTruthy();
    expect(screen.getByText("the island remembers.")).toBeTruthy();
  });

  it("composer: pill pinned to the panel bottom, mic inside its right end, attach outside", () => {
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const inner = root.querySelector(".mk-dialog-inner");
    const row = root.querySelector(".mk-dialog-composer");
    const form = root.querySelector("form.mk-dialog-io");
    // bottom-pinned: the composer row is the last block of the flex column
    expect(inner.lastElementChild).toBe(row);
    // ONLY the input and the mic live inside the pill; Enter sends
    const input = screen.getByRole("textbox", { name: /speak to keeper of dreams/i });
    expect(input.closest("form")).toBe(form);
    const mic = screen.getByRole("button", { name: /toggle talking/i });
    expect(mic.closest("form")).toBe(form);
    expect(form.lastElementChild).toBe(mic); // the mic caps the pill's right end
    // the attach button sits OUTSIDE the pill, at the row's right
    const attach = screen.getByRole("button", { name: /attach a memory file/i });
    expect(attach.closest("form")).toBeNull();
    expect(row.lastElementChild).toBe(attach);
  });

  it("one input serves the whole conversation: no tabs, the speaker toggle lives in the header", () => {
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(screen.queryByRole("tab")).toBeNull();
    const input = screen.getByRole("textbox", { name: /speak to keeper of dreams/i });
    expect(input.placeholder).toBe("tell her a memory, or ask her anything...");
    const spk = screen.getByRole("button", { name: /toggle voice replies/i });
    expect(spk.closest(".holo-panel__head")).not.toBeNull();
    // the chat scrollback reads as its own framed block
    const hist = root.querySelector(".mk-dialog-hist");
    expect(hist.getAttribute("aria-label")).toBe("recent exchanges");
  });

  it("tell flow: typing enables submit, reply types out into the chat while SPEAKING", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, async ({ request }) => {
        const body = await request.json();
        expect(body).toEqual({ text: "I flew over a black ocean" });
        await gate.promise;
        return HttpResponse.json({
          reply: "I wrote it down.",
          book: { slug: "2026-07-02-flying", title: "Flying" },
        });
      }),
    );
    const created = vi.fn();
    const voiceStates = [];
    bus.on("book:created", created);
    bus.on("voice:state", (p) => voiceStates.push(p.mode));
    bus.emit("keeper:selected", "dreams");

    const input = screen.getByRole("textbox", { name: /speak to keeper of dreams/i });
    await user.type(input, "I flew over a black ocean");
    await user.keyboard("{Enter}");
    // in flight: the voice mode listens and the pill wears the thinking border
    expect(voiceStates[voiceStates.length - 1]).toBe("listening");

    gate.resolve();
    await screen.findByText("I wrote it down."); // typed itself out
    expect(voiceStates[voiceStates.length - 1]).toBe("speaking");
    expect(screen.getByText("I flew over a black ocean")).toBeTruthy(); // scrollback
    expect(input.value).toBe("");
    expect(created).toHaveBeenCalledWith({
      keeperId: "dreams",
      book: { slug: "2026-07-02-flying", title: "Flying" },
    });
    expect(state.keepers[0].book_count).toBe(3); // bumped from 2
    expect(voiceStates).toContain("listening");
    expect(voiceStates).toContain("speaking");
    // after the speaking beat the voice mode settles back to idle
    await waitFor(() => expect(voiceStates[voiceStates.length - 1]).toBe("idle"), { timeout: 2500 });
  });

  it("Enter inside the pill sends too", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json({ reply: "noted by enter.", book: { slug: "b", title: "B" } }),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const input = screen.getByRole("textbox", { name: /speak to keeper of dreams/i });
    await user.type(input, "remember the rain{Enter}");
    await screen.findByText("noted by enter.");
    expect(input.value).toBe("");
  });

  it("tell failure: toast shown, input preserved, submit re-enabled, voice back to idle", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json(
          { error: { code: "HARNESS_ERROR", message: "the harness exploded" } },
          { status: 502 },
        ),
      ),
    );
    const voiceStates = [];
    bus.on("voice:state", (p) => voiceStates.push(p.mode));
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const input = screen.getByRole("textbox", { name: /speak to/i });
    await user.type(input, "remember this");
    await user.keyboard("{Enter}");

    await screen.findByText("the harness exploded"); // toast
    expect(input.value).toBe("remember this");
    await waitFor(() => expect(voiceStates[voiceStates.length - 1]).toBe("idle"));
    expect(state.keepers[0].book_count).toBe(2); // unchanged
  });

  it("unconscious keepers are chattable: Tell works, keeps no book, shows the whisper hint", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/still-water/say`, () =>
        HttpResponse.json({ reply: "I hear you. The water is listening." }),
      ),
    );
    const created = vi.fn();
    bus.on("book:created", created);
    bus.emit("keeper:selected", { keeperId: "still-water" });

    // no observe-only note anymore; a soft hint instead
    expect(screen.queryByText(/cannot be told anything/i)).toBeNull();
    const hint = screen.getByText(/keeps no books of what you tell her/i);
    expect(hint.textContent).toMatch(/born from dreaming/i);

    const input = screen.getByRole("textbox", { name: /speak to the still water/i });
    await user.type(input, "I am afraid of the deep");
    await user.keyboard("{Enter}");

    await screen.findByText("I hear you. The water is listening.");
    expect(created).not.toHaveBeenCalled(); // conversational: no book was born
    expect(state.keepers[1].book_count).toBe(1); // unchanged
    expect(hint.isConnected).toBe(true); // the hint stays with the composer
  });

  it("ask flow: answer types out, consulted books clickable and emit book:open", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json({
          kind: "ask",
          answer: "You dreamt of water.",
          sources: [
            { slug: "2026-07-02-flying-over-water", title: "Flying over water" },
            { slug: "2026-07-01-the-tide", title: "The tide" },
          ],
        }),
      ),
    );
    const opened = vi.fn();
    bus.on("book:open", opened);
    bus.emit("keeper:selected", { keeperId: "dreams" });

    const input = screen.getByRole("textbox", { name: /speak to keeper of dreams/i });
    await user.type(input, "what did I dream?");
    await user.keyboard("{Enter}");

    await screen.findByText("You dreamt of water.");
    const row = screen.getByRole("button", { name: "Flying over water" });
    expect(screen.getByRole("button", { name: "The tide" })).toBeTruthy();
    await user.click(row);
    expect(opened).toHaveBeenCalledWith({
      keeperId: "dreams",
      slug: "2026-07-02-flying-over-water",
    });
  });

  it("ask failure toasts and keeps the question", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json({ error: { code: "HARNESS_ERROR", message: "no answer today" } }, { status: 502 }),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const input = screen.getByRole("textbox", { name: /speak to/i });
    await user.type(input, "hello?");
    await user.keyboard("{Enter}");
    await screen.findByText("no answer today");
    expect(input.value).toBe("hello?");
  });

  it("speaker button toggles and emits voice:tts", async () => {
    const user = userEvent.setup();
    const tts = vi.fn();
    bus.on("voice:tts", tts);
    bus.emit("keeper:selected", { keeperId: "dreams" });

    const ttsBtn = screen.getByRole("button", { name: /toggle voice replies/i });
    expect(ttsBtn.getAttribute("aria-pressed")).toBe("false");
    await user.click(ttsBtn);
    expect(tts).toHaveBeenCalledWith({ keeperId: "dreams", on: true });
    expect(ttsBtn.getAttribute("aria-pressed")).toBe("true");
    await user.click(ttsBtn);
    expect(tts).toHaveBeenCalledWith({ keeperId: "dreams", on: false });
  });

  it("only the X closes the panel; Escape leaves it open", async () => {
    const user = userEvent.setup();
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(dialog.isOpen()).toBe(true);
    await user.keyboard("{Escape}");
    expect(dialog.isOpen()).toBe(true);

    await user.click(screen.getByRole("button", { name: /close talk panel/i }));
    expect(dialog.isOpen()).toBe(false);
    expect(screen.queryByRole("heading", { name: "Keeper of Dreams" })).toBeNull();
  });

  it("join button: click closes and emits keeper:join; hidden inside her own house", async () => {
    const user = userEvent.setup();
    const joined = vi.fn();
    bus.on("keeper:join", joined);
    bus.emit("keeper:selected", { keeperId: "dreams" });

    const join = screen.getByRole("button", { name: "Join instance" });
    await user.click(join);

    expect(joined).toHaveBeenCalledWith({ keeperId: "dreams" });
    expect(dialog.isOpen()).toBe(false);
    expect(screen.queryByRole("heading", { name: "Keeper of Dreams" })).toBeNull();

    // already in her interior: the player is with her, no Join button
    state.mode = "interior:dreams";
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(dialog.isOpen()).toBe(true);
    expect(screen.queryByRole("button", { name: "Join instance" })).toBeNull();
  });

  it("closes when an instance returns to the island", () => {
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(dialog.isOpen()).toBe(true);
    bus.emit("mode:changed", { mode: "overworld", prev: "interior:dreams" });
    expect(dialog.isOpen()).toBe(false);
    // a plain mode change that never left an interior keeps the panel open
    bus.emit("keeper:selected", { keeperId: "dreams" });
    bus.emit("mode:changed", { mode: "graph", prev: "overworld" });
    expect(dialog.isOpen()).toBe(true);
  });

  it("join button is absent when no keeper is selected", () => {
    expect(screen.queryByRole("button", { name: /^join/i })).toBeNull();
    bus.emit("keeper:selected", { keeperId: "dreams" });
    dialog.close();
    expect(screen.queryByRole("button", { name: /^join/i })).toBeNull();
  });

  it("emits ui:open / ui:close over the panel lifecycle", () => {
    const opened = vi.fn();
    const closed = vi.fn();
    bus.on("ui:open", opened);
    bus.on("ui:close", closed);
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(opened).toHaveBeenCalledWith({ panel: "dialog", keeperId: "dreams" });
    dialog.close();
    expect(closed).toHaveBeenCalledWith({ panel: "dialog" });
  });

  it("injects exactly one scoped style tag", () => {
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(document.querySelectorAll("#mk-dialog-style")).toHaveLength(1);
  });

  it("wears the thinking border on the whole pill while a tell is in flight, clears it after", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, async () => {
        await gate.promise;
        return HttpResponse.json({ reply: "noted.", book: { slug: "b", title: "B" } });
      }),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });

    const form = screen.getByRole("textbox", { name: /speak to/i }).closest("form");
    expect(form.classList.contains("mk-dialog-io")).toBe(true);
    expect(form.classList.contains("holo-thinking")).toBe(false);

    await user.type(screen.getByRole("textbox", { name: /speak to/i }), "remember the rain");
    await user.keyboard("{Enter}");
    expect(form.classList.contains("holo-thinking")).toBe(true); // spinning glow

    gate.resolve();
    await screen.findByText("noted.");
    expect(form.classList.contains("holo-thinking")).toBe(false);
  });

  it("wears the thinking border for asks too, clearing even on failure", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json({ error: { code: "HARNESS_ERROR", message: "boom" } }, { status: 502 }),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const input = screen.getByRole("textbox", { name: /speak to/i });
    const form = input.closest("form");
    await user.type(input, "anything?");
    await user.keyboard("{Enter}");
    await screen.findByText("boom");
    expect(form.classList.contains("holo-thinking")).toBe(false);
  });

  it("grounded ask: clickable book links under the reply, staggered glow, memory:used", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json({
          kind: "ask",
          answer: "You dreamt of water.",
          grounded: true,
          followup: false,
          sources: [
            { slug: "2026-07-02-flying-over-water", title: "Flying over water", tags: ["flying", "ocean"] },
            { slug: "2026-07-01-the-tide", title: "The tide", tags: ["ocean"] },
          ],
        }),
      ),
    );
    const used = vi.fn();
    const opened = vi.fn();
    bus.on("memory:used", used);
    bus.on("book:open", opened);
    bus.emit("keeper:selected", { keeperId: "dreams" });

    await user.type(screen.getByRole("textbox", { name: /speak to/i }), "what did I dream?");
    await user.keyboard("{Enter}");

    const box = await screen.findByLabelText("consulted books");
    // memory:used fires exactly when the list appears, once, with the slugs
    expect(used).toHaveBeenCalledTimes(1);
    expect(used).toHaveBeenCalledWith({
      keeperId: "dreams",
      slugs: ["2026-07-02-flying-over-water", "2026-07-01-the-tide"],
    });

    const rows = box.querySelectorAll(".mk-dialog-book");
    expect(rows).toHaveLength(2);
    // spine-colored bars + visible titles, glow staggered, lead strongest
    expect(rows[0].title).toBe("Flying over water");
    expect(rows[0].textContent).toContain("Flying over water");
    expect(rows[1].textContent).toContain("The tide");
    expect(rows[0].classList.contains("mk-dialog-book--lead")).toBe(true);
    expect(rows[1].classList.contains("mk-dialog-book--lead")).toBe(false);
    expect(rows[0].style.animationDelay).toBe("0ms");
    expect(rows[1].style.animationDelay).toBe("220ms");
    expect(
      rows[0].querySelector(".mk-dialog-spine").style.getPropertyValue("--mk-book-spine"),
    ).toBe(spineColorFromTags(["flying", "ocean"]));
    // the links sit inside the chat block, attached under her reply text
    const hist = root.querySelector(".mk-dialog-hist");
    expect(hist.contains(box)).toBe(true);
    const replyRow = box.closest(".mk-dialog-hist-row-keeper");
    expect(replyRow).not.toBeNull();
    await screen.findByText("You dreamt of water."); // her text, same row
    expect(replyRow.textContent).toContain("You dreamt of water.");

    // clicking a book row opens the reader
    await user.click(rows[0]);
    expect(opened).toHaveBeenCalledWith({
      keeperId: "dreams",
      slug: "2026-07-02-flying-over-water",
    });
  });

  it("a long source list renders every book as a link, no paging", async () => {
    const user = userEvent.setup();
    const sources = Array.from({ length: 6 }, (_, i) => ({
      slug: `book-${i}`,
      title: `Book ${i}`,
      tags: [`tag-${i}`],
    }));
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json({ kind: "ask", answer: "Many books.", grounded: true, followup: false, sources }),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.type(screen.getByRole("textbox", { name: /speak to/i }), "everything?");
    await user.keyboard("{Enter}");

    const box = await screen.findByLabelText("consulted books");
    expect(box.querySelectorAll(".mk-dialog-book")).toHaveLength(6);
    expect(screen.queryByRole("button", { name: /scroll books/ })).toBeNull();
  });

  it("ungrounded ask with followup: no-memory hint + save shortcut pre-fills the input", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json({
          kind: "ask",
          answer: "When did that concert happen?",
          sources: [],
          grounded: false,
          followup: true,
        }),
      ),
    );
    const used = vi.fn();
    bus.on("memory:used", used);
    bus.emit("keeper:selected", { keeperId: "dreams" });

    await user.type(screen.getByRole("textbox", { name: /speak to/i }), "the concert we went to");
    await user.keyboard("{Enter}");

    await screen.findByText(/she does not remember this/i);
    // her follow-up question is the typed reply in the same chat row
    await screen.findByText("When did that concert happen?");
    const hint = root.querySelector(".mk-dialog-nomem");
    expect(hint.closest(".mk-dialog-hist-row-keeper")).not.toBeNull();
    expect(screen.queryByLabelText("consulted books")).toBeNull();
    expect(used).not.toHaveBeenCalled();

    // the shortcut pre-fills the input with keep-this wording (routes as tell)
    await user.click(screen.getByRole("button", { name: /save this as a memory/i }));
    const input = screen.getByRole("textbox", { name: /speak to keeper of dreams/i });
    expect(input.value).toBe("Remember this: the concert we went to");
  });

  it("an ungrounded answer without followup renders as a plain reply (a question about her)", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json({
          kind: "ask",
          answer: "I keep your dreams and can look up songs and movies.",
          sources: [],
          grounded: false,
          followup: false,
        }),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.type(screen.getByRole("textbox", { name: /speak to/i }), "what can you do?");
    await user.keyboard("{Enter}");
    await screen.findByText(/I keep your dreams/);
    expect(screen.queryByText(/she does not remember this/i)).toBeNull();
  });

  it("the + button attaches a .md file: its content is sent to keep, the chat shows the file reference", async () => {
    const user = userEvent.setup();
    let sent = null;
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ kind: "tell", reply: "Kept from your file." });
      }),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const file = new File(["# March\nWe sailed at dawn."], "march-notes.md", { type: "text/markdown" });
    const picker = root.querySelector('input[type="file"]');
    Object.defineProperty(picker, "files", { configurable: true, value: [file] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await screen.findByText("Kept from your file.");
    expect(sent.text).toContain('my file "march-notes.md"');
    expect(sent.text).toContain("We sailed at dawn.");
    expect(screen.getByText("[file] march-notes.md")).toBeTruthy(); // scrollback reference
  });

  it("omits the save shortcut for unconscious keepers (telling writes no book)", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/still-water/say`, () =>
        HttpResponse.json({ kind: "ask", answer: "Who told you?", sources: [], grounded: false, followup: true }),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "still-water" });
    await user.type(screen.getByRole("textbox", { name: /speak to/i }), "the deep?");
    await user.keyboard("{Enter}");
    await screen.findByText(/she does not remember this/i);
    expect(screen.queryByRole("button", { name: /save this as a memory/i })).toBeNull();
  });

  it("header shows the level badge and a rest meter fed from keeper.session", () => {
    state.keepers[0].level = 3;
    state.keepers[0].session = { tokens_used: 200, budget: 1000, status: "rested" };
    bus.emit("keeper:selected", { keeperId: "dreams" });

    expect(screen.getByText("LV 3")).toBeTruthy();
    const meter = screen.getByRole("progressbar", { name: "rest meter" });
    expect(meter.getAttribute("aria-valuenow")).toBe("20");
    expect(meter.classList.contains("mk-dialog-rest--cyan")).toBe(true);
    expect(meter.querySelector(".mk-dialog-rest-fill").style.width).toBe("20%");
    // rested: no sleep prompt
    expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe("none");
  });

  it("defaults to LV 1 and an empty cyan meter when the engine has no session data yet", () => {
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(screen.getByText("LV 1")).toBeTruthy();
    const meter = screen.getByRole("progressbar", { name: "rest meter" });
    expect(meter.getAttribute("aria-valuenow")).toBe("0");
    expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe("none");
  });

  it("state:loaded refreshes the open panel's session cluster from server truth", () => {
    state.keepers[0].level = 2;
    state.keepers[0].session = { tokens_used: 0, budget: 1000, status: "rested" };
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe("none");

    // Out-of-band exhaustion (another tab, dev tools): a state re-sync must
    // surface the sleep prompt and the fresh meter without reopening.
    state.keepers[0].level = 3;
    state.keepers[0].session = { tokens_used: 900, budget: 1000, status: "needs_sleep" };
    bus.emit("state:loaded", { state, consolidation: {} });

    expect(screen.getByText("LV 3")).toBeTruthy();
    const meter = screen.getByRole("progressbar", { name: "rest meter" });
    expect(meter.classList.contains("mk-dialog-rest--red")).toBe(true);
    expect(meter.getAttribute("aria-valuenow")).toBe("90");
    expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe("");
    expect(screen.getByText("she needs to dream")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to sleep" })).toBeTruthy();
  });

  it("getting tired: amber meter, status line and the Send to sleep button appear", () => {
    state.keepers[0].session = { tokens_used: 700, budget: 1000, status: "unrested" };
    bus.emit("keeper:selected", { keeperId: "dreams" });

    const meter = screen.getByRole("progressbar", { name: "rest meter" });
    expect(meter.classList.contains("mk-dialog-rest--amber")).toBe(true);
    expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe("");
    expect(screen.getByText("she is getting tired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to sleep" })).toBeTruthy();
  });

  it("send-to-sleep lifecycle: api.sleep, keeper:sleep, locked inputs, poll to done, keeper:rested", async () => {
    const user = userEvent.setup();
    state.keepers[0].level = 3;
    state.keepers[0].session = { tokens_used: 960, budget: 1000, status: "needs_sleep" };
    let polls = 0;
    server.use(
      http.post(`${BASE}/keepers/dreams/sleep`, () =>
        HttpResponse.json({ job_id: "job-1", status: "running" }, { status: 202 }),
      ),
      http.get(`${BASE}/keepers/dreams/sleep/job-1`, () => {
        polls++;
        return HttpResponse.json({ status: polls < 2 ? "running" : "done" });
      }),
      http.get(`${BASE}/keepers/dreams`, () =>
        HttpResponse.json({
          ...dreamsKeeper(),
          level: 4,
          session: { tokens_used: 0, budget: 1000, status: "rested" },
        }),
      ),
    );
    const slept = vi.fn();
    const rested = vi.fn();
    bus.on("keeper:sleep", slept);
    bus.on("keeper:rested", rested);
    bus.emit("keeper:selected", { keeperId: "dreams" });

    const meter = screen.getByRole("progressbar", { name: "rest meter" });
    expect(meter.classList.contains("mk-dialog-rest--red")).toBe(true);
    expect(screen.getByText("she needs to dream")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Send to sleep" }));
    // dreaming: the composer and the button lock, the status line flips
    expect(screen.getByText("dreaming...")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to sleep" }).disabled).toBe(true);
    expect(screen.getByRole("textbox", { name: /speak to/i }).disabled).toBe(true);

    await waitFor(() => expect(rested).toHaveBeenCalledWith({ keeperId: "dreams" }));
    expect(slept).toHaveBeenCalledTimes(1);
    expect(slept).toHaveBeenCalledWith({ keeperId: "dreams" });
    expect(polls).toBeGreaterThanOrEqual(2);

    // she comes back lighter: fresh session, level bump, inputs unlocked
    await waitFor(() =>
      expect(screen.getByRole("progressbar", { name: "rest meter" }).getAttribute("aria-valuenow")).toBe("0"),
    );
    expect(screen.getByText("LV 4")).toBeTruthy();
    expect(state.keepers[0].level).toBe(4);
    expect(screen.getByRole("textbox", { name: /speak to/i }).disabled).toBe(false);
    expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe("none");
  });

  it("a sleep poll that dies after she left still wakes her: keeper:rested follows the toast", async () => {
    const user = userEvent.setup();
    state.keepers[0].session = { tokens_used: 960, budget: 1000, status: "needs_sleep" };
    server.use(
      http.post(`${BASE}/keepers/dreams/sleep`, () =>
        HttpResponse.json({ job_id: "job-2", status: "running" }, { status: 202 }),
      ),
      http.get(`${BASE}/keepers/dreams/sleep/job-2`, () => HttpResponse.error()),
    );
    const rested = vi.fn();
    bus.on("keeper:rested", rested);
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.click(screen.getByRole("button", { name: "Send to sleep" }));
    await waitFor(() => expect(rested).toHaveBeenCalledWith({ keeperId: "dreams" }));
    expect(screen.getByRole("button", { name: "Send to sleep" }).disabled).toBe(false);
  });

  it("sleep failure: toast, prompt stays, the composer stays locked (she still cannot answer)", async () => {
    const user = userEvent.setup();
    state.keepers[0].session = { tokens_used: 900, budget: 1000, status: "needs_sleep" };
    server.use(
      http.post(`${BASE}/keepers/dreams/sleep`, () =>
        HttpResponse.json(
          { error: { code: "SLEEP_RUNNING", message: "already dreaming" } },
          { status: 409 },
        ),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.click(screen.getByRole("button", { name: "Send to sleep" }));

    await screen.findByText("already dreaming"); // toast
    expect(screen.getByRole("button", { name: "Send to sleep" }).disabled).toBe(false);
    expect(screen.getByRole("textbox", { name: /speak to/i }).disabled).toBe(true);
    expect(screen.getByText("she needs to dream")).toBeTruthy();
  });

  it("409 NEEDS_SLEEP (shared tell/ask branch) renders the send-to-sleep prompt instead of a toast", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json(
          { error: { code: "NEEDS_SLEEP", message: "she is too tired" } },
          { status: 409 },
        ),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe("none");

    await user.type(screen.getByRole("textbox", { name: /speak to/i }), "one more thing");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe(""),
    );
    expect(screen.getByText("she needs to dream")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to sleep" })).toBeTruthy();
    const meter = screen.getByRole("progressbar", { name: "rest meter" });
    expect(meter.classList.contains("mk-dialog-rest--red")).toBe(true);
    expect(screen.queryByText("she is too tired")).toBeNull(); // no raw toast
  });

  it("409 LIBRARY_FULL from tell: warm inline note + Send to sleep, cleared once she dreams", async () => {
    const user = userEvent.setup();
    let polls = 0;
    server.use(
      http.post(`${BASE}/keepers/dreams/say`, () =>
        HttpResponse.json(
          { error: { code: "LIBRARY_FULL", message: "bookcase at capacity" } },
          { status: 409 },
        ),
      ),
      http.post(`${BASE}/keepers/dreams/sleep`, () =>
        HttpResponse.json({ job_id: "job-2", status: "running" }, { status: 202 }),
      ),
      http.get(`${BASE}/keepers/dreams/sleep/job-2`, () => {
        polls++;
        return HttpResponse.json({ status: polls < 2 ? "running" : "done" });
      }),
      http.get(`${BASE}/keepers/dreams`, () =>
        HttpResponse.json({
          ...dreamsKeeper(),
          session: { tokens_used: 0, budget: 1000, status: "rested" },
        }),
      ),
    );
    const rested = vi.fn();
    bus.on("keeper:rested", rested);
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe("none");

    await user.type(screen.getByRole("textbox", { name: /speak to/i }), "one book too many");
    await user.keyboard("{Enter}");

    // the warm inline note, not a toast
    await screen.findByText(/her library is full/i);
    expect(screen.getByText(/she needs to dream to make room/i)).toBeTruthy();
    expect(screen.queryByText("bookcase at capacity")).toBeNull();
    const row = root.querySelector(".mk-dialog-sleeprow");
    expect(row.style.display).toBe("");
    expect(row.classList.contains("mk-dialog-sleeprow--red")).toBe(true);

    // the same shortcut as NEEDS_SLEEP: dreaming makes room and clears it
    await user.click(screen.getByRole("button", { name: "Send to sleep" }));
    await waitFor(() => expect(rested).toHaveBeenCalledWith({ keeperId: "dreams" }));
    await waitFor(() =>
      expect(root.querySelector(".mk-dialog-sleeprow").style.display).toBe("none"),
    );
    expect(screen.queryByText(/her library is full/i)).toBeNull();
  });

  it("injects the holo kit styles before its own so .mk-dialog positioning wins the cascade", () => {
    // Regression: the kit's .holo-panel shell used to land AFTER
    // #mk-dialog-style and its position rule overrode the panel anchor,
    // pushing the comm panel to the top-left corner.
    const ids = [...document.head.querySelectorAll("style")].map((s) => s.id);
    expect(ids).toContain("holo-kit-style");
    expect(ids).toContain("mk-dialog-style");
    expect(ids.indexOf("holo-kit-style")).toBeLessThan(ids.indexOf("mk-dialog-style"));
  });
});

describe("restTone (pure)", () => {
  it("fills cyan -> amber -> red as the session budget is consumed", () => {
    expect(restTone({ tokens_used: 100, budget: 1000, status: "rested" })).toEqual({
      ratio: 0.1,
      tone: "cyan",
      label: "",
      status: "rested",
    });
    expect(restTone({ tokens_used: 700, budget: 1000, status: "rested" }).tone).toBe("amber");
    expect(restTone({ tokens_used: 900, budget: 1000, status: "rested" }).tone).toBe("red");
  });

  it("status overrides the ratio tone and provides the warm label", () => {
    const tired = restTone({ tokens_used: 100, budget: 1000, status: "unrested" });
    expect(tired.tone).toBe("amber"); // never calmer than amber while tiring
    expect(tired.label).toBe("getting tired");
    const needs = restTone({ tokens_used: 100, budget: 1000, status: "needs_sleep" });
    expect(needs.tone).toBe("red");
    expect(needs.label).toBe("needs to dream");
  });

  it("tolerates missing or malformed sessions", () => {
    expect(restTone(null)).toEqual({ ratio: 0, tone: "cyan", label: "", status: "rested" });
    expect(restTone({ tokens_used: 50, budget: 0 }).ratio).toBe(0);
    expect(restTone({ tokens_used: 99999, budget: 100 }).ratio).toBe(1);
  });
});

describe("bookSpineColor (pure)", () => {
  it("matches the interior shelf spine colors (same tags -> same color)", () => {
    for (const tags of [["flying", "ocean"], ["ocean"], [], ["a", "b", "c"]]) {
      expect(bookSpineColor(tags)).toBe(spineColorFromTags(tags));
    }
  });

  it("is order-insensitive and always a hex color", () => {
    expect(bookSpineColor(["ocean", "flying"])).toBe(bookSpineColor(["flying", "ocean"]));
    expect(bookSpineColor(["dream"])).toMatch(/^#[0-9a-f]{6}$/);
    expect(bookSpineColor(undefined)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("the main keeper rides the same dialog", () => {
  it("opens via keeper:selected: same panel, no Join, no tabs, no session cluster", () => {
    bus.emit("keeper:selected", { keeperId: MONUMENT_ID });
    expect(screen.getByRole("heading", { name: "Memory Keeper" })).toBeTruthy();
    expect(root.querySelectorAll(".mk-dialog")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Tell" })).toBeNull();
    expect(root.querySelector(".mk-dialog-rest")).toBeNull();
  });

  it("re-selecting never stacks panels, and a keeper replaces her panel", () => {
    bus.emit("keeper:selected", { keeperId: MONUMENT_ID });
    bus.emit("keeper:selected", { keeperId: MONUMENT_ID });
    expect(root.querySelectorAll(".mk-dialog")).toHaveLength(1);
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(screen.getByRole("heading", { name: "Keeper of Dreams" })).toBeTruthy();
    expect(root.querySelectorAll(".mk-dialog")).toHaveLength(1);
  });

  it("sends through api.monument and announces the created keeper", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/monument`, () =>
        HttpResponse.json({
          reply: "Done. Keeper of Films has her house now.",
          created_keeper: { id: "films", name: "Keeper of Films", side: "light" },
        }),
      ),
    );
    const created = [];
    bus.on("keeper:created", (k) => created.push(k));
    bus.emit("keeper:selected", { keeperId: MONUMENT_ID });
    const input = screen.getByRole("textbox", { name: /speak to memory keeper/i });
    await user.type(input, "I want a keeper for films");
    await user.keyboard("{Enter}");
    await screen.findByText(/has her house now/i);
    expect(created[0]?.id).toBe("films");
    expect(input.value).toBe("");
  });
});
