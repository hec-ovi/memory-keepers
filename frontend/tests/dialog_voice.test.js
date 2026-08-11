// Voice in the comm panel: push-to-talk (hold T) and the mic toggle
// through api.stt, and spoken replies through api.tts when the speaker
// toggle is on. jsdom has no media stack, so the mic and recorder are
// minimal fakes and HTMLMediaElement.play is stubbed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createBus } from "../src/bus.js";
import { createApi } from "../src/api/api.js";
import { createToasts } from "../src/ui/toasts.js";
import { createDialog, MONUMENT_ID } from "../src/ui/dialog.js";
import { BASE, dreamsKeeper, unconsciousKeeper, makeState } from "./ui_fixtures.js";

const server = setupServer();
const noSleep = () => Promise.resolve();

// Minimal MediaRecorder: start/stop only, one opus chunk per recording.
class FakeMediaRecorder {
  static instances = [];
  static isTypeSupported(type) {
    return type === "audio/webm;codecs=opus";
  }
  constructor(stream, { mimeType } = {}) {
    this.stream = stream;
    this.mimeType = mimeType;
    this.state = "inactive";
    this.listeners = { dataavailable: [], stop: [] };
    FakeMediaRecorder.instances.push(this);
  }
  addEventListener(type, fn) {
    this.listeners[type].push(fn);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const data = new Blob(["opus-bytes"], { type: this.mimeType });
    for (const fn of this.listeners.dataavailable) fn({ data });
    for (const fn of this.listeners.stop) fn();
  }
}

let root, bus, state, toasts, dialog, getUserMedia, tracks, playSpy;

const vizMode = () => root.querySelector(".holo-voice")?.dataset.mode;
const micButton = () => screen.getByRole("button", { name: /toggle talking/i });
const speakerToggle = () => screen.getByRole("button", { name: /toggle voice replies/i });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
  FakeMediaRecorder.instances = [];
  window.MediaRecorder = FakeMediaRecorder;
  tracks = [{ stop: vi.fn() }];
  getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  root = document.createElement("div");
  document.body.appendChild(root);
  bus = createBus();
  state = makeState([dreamsKeeper(), unconsciousKeeper()]);
  toasts = createToasts({ root });
  const api = createApi({ baseUrl: BASE, sleep: noSleep });
  dialog = createDialog({ root, state, bus, api, toasts, sleepPollMs: 5 });
});

afterEach(() => {
  dialog.dispose();
  toasts.dispose();
  root.remove();
  server.resetHandlers();
  delete window.MediaRecorder;
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
  vi.restoreAllMocks();
});

describe("push-to-talk", () => {
  it("hold T records (listening viz, voice:mic) and sends the transcription like a typed message", async () => {
    const user = userEvent.setup();
    let told = null;
    server.use(
      http.post(`${BASE}/voice/stt`, () => HttpResponse.json({ text: "I flew over a black ocean" })),
      http.post(`${BASE}/keepers/dreams/tell`, async ({ request }) => {
        told = await request.json();
        return HttpResponse.json({ reply: "I wrote it down." });
      }),
    );
    const mic = vi.fn();
    bus.on("voice:mic", mic);
    bus.emit("keeper:selected", { keeperId: "dreams" });

    await user.keyboard("{t>}");
    expect(mic).toHaveBeenCalledWith({ keeperId: "dreams", on: true });
    expect(micButton().getAttribute("aria-pressed")).toBe("true");
    expect(vizMode()).toBe("listening");
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    expect(FakeMediaRecorder.instances[0].mimeType).toBe("audio/webm;codecs=opus");

    await user.keyboard("{/t}");
    expect(mic).toHaveBeenCalledWith({ keeperId: "dreams", on: false });
    expect(micButton().getAttribute("aria-pressed")).toBe("false");
    await screen.findByText("I wrote it down.");
    expect(told).toEqual({ text: "I flew over a black ocean" });
    expect(screen.getByRole("textbox", { name: /tell/i }).value).toBe("");
  });

  it("T aimed at the composer input types instead of recording", async () => {
    const user = userEvent.setup();
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const input = screen.getByRole("textbox", { name: /tell/i });
    await user.click(input);
    await user.keyboard("t");
    expect(input.value).toBe("t");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it("the mic button toggles: click records (page inert), click again stops and sends", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/voice/stt`, () => HttpResponse.json({ text: "hello from the mic" })),
      http.post(`${BASE}/keepers/dreams/tell`, () => HttpResponse.json({ reply: "heard you." })),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const micBtn = micButton();

    await user.click(micBtn);
    expect(micBtn.getAttribute("aria-pressed")).toBe("true");
    expect(vizMode()).toBe("listening");
    expect(document.body.classList.contains("ui-recording")).toBe(true);
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));

    await user.click(micBtn);
    expect(micBtn.getAttribute("aria-pressed")).toBe("false");
    expect(document.body.classList.contains("ui-recording")).toBe(false);
    await screen.findByText("heard you.");
  });

  it("VOICE_UNAVAILABLE from stt: one warm toast and the mic rests for the session", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/voice/stt`, () =>
        HttpResponse.json(
          { error: { code: "VOICE_UNAVAILABLE", message: "no speech configured" } },
          { status: 503 },
        ),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });

    await user.keyboard("{t>}");
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    await user.keyboard("{/t}");

    await screen.findByText(/voice is not available here/i);
    expect(micButton().disabled).toBe(true);
    expect(screen.queryByText("no speech configured")).toBeNull(); // warm copy only
    // resting: holding T again records nothing
    await user.keyboard("{t>}{/t}");
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("a denied microphone rests voice the same way", async () => {
    const user = userEvent.setup();
    getUserMedia.mockRejectedValue(new Error("denied"));
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.keyboard("{t>}{/t}");
    await screen.findByText(/voice is not available here/i);
    expect(micButton().disabled).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it("an empty transcription toasts gently and sends nothing", async () => {
    const user = userEvent.setup();
    server.use(http.post(`${BASE}/voice/stt`, () => HttpResponse.json({ text: "   " })));
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.keyboard("{t>}");
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    await user.keyboard("{/t}");
    await screen.findByText(/no words came through/i);
    // nothing landed in the composer, no tell left the panel (MSW would error)
    expect(screen.getByRole("textbox", { name: /tell/i }).value).toBe("");
  });
});

describe("spoken replies", () => {
  it("speaker on: a completed reply is fetched from /voice/tts with her kind and played", async () => {
    const user = userEvent.setup();
    let ttsBody = null;
    server.use(
      http.post(`${BASE}/keepers/dreams/tell`, () => HttpResponse.json({ reply: "I wrote it down." })),
      http.post(`${BASE}/voice/tts`, async ({ request }) => {
        ttsBody = await request.json();
        return new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
          headers: { "content-type": "audio/ogg" },
        });
      }),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.click(speakerToggle());

    await user.type(screen.getByRole("textbox", { name: /tell/i }), "remember the rain{Enter}");
    await screen.findByText("I wrote it down.");
    await waitFor(() => expect(ttsBody).toEqual({ text: "I wrote it down.", kind: "light" }));
    await waitFor(() => expect(playSpy).toHaveBeenCalled());
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("speaks with her voice: dark for the unconscious, monument for the main keeper", async () => {
    const user = userEvent.setup();
    const kinds = [];
    server.use(
      http.post(`${BASE}/keepers/still-water/tell`, () =>
        HttpResponse.json({ reply: "the water hears." }),
      ),
      http.post(`${BASE}/monument`, () => HttpResponse.json({ reply: "the island answers." })),
      http.post(`${BASE}/voice/tts`, async ({ request }) => {
        kinds.push((await request.json()).kind);
        return new HttpResponse(new Uint8Array([1]).buffer, {
          headers: { "content-type": "audio/ogg" },
        });
      }),
    );
    bus.emit("keeper:selected", { keeperId: "still-water" });
    await user.click(speakerToggle());
    await user.type(screen.getByRole("textbox", { name: /tell the still water/i }), "hello{Enter}");
    await screen.findByText("the water hears.");
    await waitFor(() => expect(kinds).toEqual(["dark"]));

    bus.emit("keeper:selected", { keeperId: MONUMENT_ID });
    await user.click(speakerToggle());
    await user.type(screen.getByRole("textbox", { name: /speak to main keeper/i }), "hello{Enter}");
    await screen.findByText("the island answers.");
    await waitFor(() => expect(kinds).toEqual(["dark", "monument"]));
  });

  it("a tts failure never breaks the reply: text stays, one gentle toast per session at most", async () => {
    const user = userEvent.setup();
    let sends = 0;
    server.use(
      http.post(`${BASE}/keepers/dreams/tell`, () =>
        HttpResponse.json({ reply: ++sends === 1 ? "first reply." : "second reply." }),
      ),
      http.post(`${BASE}/voice/tts`, () =>
        HttpResponse.json(
          { error: { code: "VOICE_UNAVAILABLE", message: "no voice" } },
          { status: 503 },
        ),
      ),
    );
    bus.emit("keeper:selected", { keeperId: "dreams" });
    await user.click(speakerToggle());

    const input = screen.getByRole("textbox", { name: /tell/i });
    await user.type(input, "one{Enter}");
    await screen.findByText("first reply.");
    await screen.findByText(/her voice could not reach you/i);

    await user.type(input, "two{Enter}");
    await screen.findByText("second reply."); // the dialog kept working
    expect(screen.getAllByText(/her voice could not reach you/i)).toHaveLength(1);
    expect(playSpy).not.toHaveBeenCalled();
  });
});
