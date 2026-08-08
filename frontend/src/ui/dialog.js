// The chat: one component for keepers and the monument, world and interior.
// Holo-styled, voice ring while listening, orb while speaking, book chips
// showing exactly which shelves grounded an answer.
import { holoPanel, toast } from "./holo.js";
import { openReader } from "./reader.js";

export class Dialog {
  constructor({ api, root, onWorldChanged, onSourcesUsed }) {
    this.api = api;
    this.root = root;
    this.onWorldChanged = onWorldChanged;
    this.onSourcesUsed = onSourcesUsed;
    this.voiceOk = true;
    this.speakReplies = false;
  }

  openKeeper(keeper) {
    this._open({
      kind: "keeper", keeper,
      title: `${keeper.name} · lv ${keeper.level}`,
      modes: keeper.side === "light" ? ["ask", "tell"] : ["ask"],
    });
  }

  openMonument() {
    this._open({ kind: "monument", title: "The Monument", modes: [] });
  }

  _open(opts) {
    this.close();
    this.opts = opts;
    this.mode = opts.modes[0] || "chat";
    this.panel = holoPanel({ title: opts.title, root: this.root, width: "420px",
      onClose: () => (this.panel = null) });

    if (opts.kind === "keeper") {
      this.meter = document.createElement("div");
      this._renderMeter(opts.keeper.session);
      this.panel.header.insertBefore(this.meter, this.panel.header.lastElementChild);
    }
    if (opts.modes.length > 1) {
      const row = document.createElement("div");
      row.className = "mode-row";
      for (const mode of opts.modes) {
        const button = document.createElement("button");
        button.textContent = mode === "tell" ? "tell her a memory" : "ask her shelves";
        button.dataset.mode = mode;
        if (mode === this.mode) button.classList.add("active");
        button.addEventListener("click", () => {
          this.mode = mode;
          row.querySelectorAll("button").forEach((b) =>
            b.classList.toggle("active", b.dataset.mode === mode));
          this.input.placeholder = this._placeholder();
        });
        row.append(button);
      }
      this.panel.el.insertBefore(row, this.panel.body);
    }

    this.log = document.createElement("div");
    this.log.className = "chat-log";
    this.panel.body.append(this.log);

    const inputRow = document.createElement("div");
    inputRow.className = "chat-input";
    this.input = document.createElement("input");
    this.input.placeholder = this._placeholder();
    this.input.setAttribute("aria-label", "message");
    const send = document.createElement("button");
    send.textContent = "➤";
    send.setAttribute("aria-label", "send");
    send.addEventListener("click", () => this._send());
    this.input.addEventListener("keydown", (e) => e.key === "Enter" && this._send());
    inputRow.append(this.input, send);

    if (this.voiceOk && typeof MediaRecorder !== "undefined") {
      this.mic = document.createElement("button");
      this.mic.className = "mic";
      this.mic.textContent = "🎙";
      this.mic.setAttribute("aria-label", "speak");
      this.mic.addEventListener("click", () => this._record());
      inputRow.append(this.mic);
    }
    this.panel.el.append(inputRow);
    this.inputRow = inputRow;
    this.input.focus();

    this._info(opts.kind === "monument"
      ? "Ask across all shelves, or ask for a new keeper."
      : opts.keeper.side === "dark"
        ? "She was born from your dreaming. Her books are not yours to write."
        : "Her books ground every answer; she never invents a memory.");
  }

  close() { this.panel?.close(); }

  _placeholder() {
    if (this.opts.kind === "monument") return "speak to the island...";
    return this.mode === "tell" ? "tell her something to keep..." : "ask what she remembers...";
  }

  _renderMeter(session) {
    if (!session || !this.meter) return;
    const ratio = Math.min(1, session.tokens_used / session.budget);
    this.meter.className = "meter " + session.status;
    this.meter.title = `session ${session.status.replace("_", " ")}`;
    this.meter.innerHTML = "";
    const fill = document.createElement("i");
    fill.style.width = (ratio * 100).toFixed(0) + "%";
    this.meter.append(fill);
  }

  _bubble(kind, text) {
    const div = document.createElement("div");
    div.className = "turn " + kind;
    div.textContent = text;
    this.log.append(div);
    this.log.scrollTop = this.log.scrollHeight;
    return div;
  }

  _info(text) { return this._bubble("info", text); }

  async _send() {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.busy = true;
    this.input.value = "";
    this._bubble("you", text);
    this.inputRow.classList.add("thinking");
    try {
      if (this.opts.kind === "monument") {
        const out = await this.api.monument(text);
        this._bubble("them", out.reply);
        this._speak(out.reply, "monument");
        if (out.created_keeper) {
          this._info(`${out.created_keeper.name} has a house now.`);
          this.onWorldChanged?.();
        }
      } else if (this.mode === "tell") {
        const out = await this.api.tell(this.opts.keeper.id, text);
        this._bubble("them", out.reply);
        this._speak(out.reply, this.opts.keeper.side);
        this._renderMeter(out.session);
        if (out.book) {
          this._chips([out.book], "kept on the shelf");
          this.onWorldChanged?.();
        }
      } else {
        const out = await this.api.ask(this.opts.keeper.id, text);
        this._bubble("them", out.answer);
        this._speak(out.answer, this.opts.keeper.side);
        this._renderMeter(out.session);
        if (out.sources?.length) {
          this._chips(out.sources, "from her books");
          this.onSourcesUsed?.(this.opts.keeper.id, out.sources);
        } else if (out.followup) {
          this._info("nothing on the shelves for that yet");
        }
      }
    } catch (error) {
      this._handleError(error);
    } finally {
      this.busy = false;
      this.inputRow.classList.remove("thinking");
    }
  }

  _chips(books, label) {
    const wrap = document.createElement("div");
    wrap.className = "sources";
    for (const book of books) {
      const chip = document.createElement("button");
      chip.className = "book-chip";
      chip.textContent = "📖 " + book.title;
      chip.title = label;
      chip.addEventListener("click", async () => {
        const full = await this.api.book(this.opts.keeper.id, book.slug);
        openReader(full, { root: this.root });
      });
      wrap.append(chip);
    }
    this.log.append(wrap);
    this.log.scrollTop = this.log.scrollHeight;
  }

  _handleError(error) {
    if (error.code === "NEEDS_SLEEP") {
      this._info("She is too tired to keep talking. Send her to sleep?");
      const button = document.createElement("button");
      button.className = "hud-btn";
      button.textContent = "send her to sleep";
      button.style.alignSelf = "center";
      button.addEventListener("click", () => this._sleep(button));
      this.log.append(button);
    } else if (error.code === "SLEEP_RUNNING") {
      this._info("She is asleep, dreaming her session smaller.");
    } else if (error.code === "LIBRARY_FULL") {
      this._info("Her bookcase is full. Sleep binds old books together to make room.");
    } else {
      this._info("something flickered: " + (error.message || error.code || error));
    }
  }

  async _sleep(button) {
    button.remove();
    const keeper = this.opts.keeper;
    const { job_id } = await this.api.sleep(keeper.id);
    const status = this._info("She walks home to sleep...");
    const timer = setInterval(async () => {
      try {
        const job = await this.api.sleepJob(keeper.id, job_id);
        if (job.status === "running") return;
        clearInterval(timer);
        status.textContent = job.status === "done"
          ? `She wakes rested. ${job.books_written.length} book(s) kept what mattered.`
          : "Her sleep was restless; try again.";
        this._renderMeter(job.session);
        this.onWorldChanged?.();
      } catch {
        clearInterval(timer);
      }
    }, 700);
  }

  async _record() {
    if (this.recorder?.state === "recording") {
      this.recorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      this.recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      this.recorder.ondataavailable = (e) => chunks.push(e.data);
      this.recorder.onstop = async () => {
        this.mic.classList.remove("recording");
        stream.getTracks().forEach((t) => t.stop());
        try {
          const { text } = await this.api.stt(new Blob(chunks, { type: "audio/webm" }));
          if (text) { this.input.value = text; this._send(); }
        } catch (error) {
          this._voiceDown(error);
        }
      };
      this.recorder.start();
      this.mic.classList.add("recording");
    } catch {
      toast("microphone unavailable");
    }
  }

  async _speak(text, side) {
    if (!this.speakReplies || !this.voiceOk) return;
    try {
      const blob = await this.api.tts(text,
        side === "monument" ? "monument" : side === "dark" ? "dark" : "light");
      const orb = document.createElement("span");
      orb.className = "speaking-orb";
      this.inputRow.prepend(orb);
      const audio = new Audio(URL.createObjectURL(blob));
      audio.onended = () => orb.remove();
      audio.play();
    } catch (error) {
      this._voiceDown(error);
    }
  }

  _voiceDown(error) {
    if (error.code === "VOICE_UNAVAILABLE") {
      this.voiceOk = false;
      this.mic?.remove();
      toast("voice is offline here; text works fully");
    }
  }
}
