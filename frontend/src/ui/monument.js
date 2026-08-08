// The Monument: the well at the plaza center is the root agent. It holds no
// books itself; it routes questions across every keeper's shelf and combines
// what they return, and it is the one who creates new keepers. Opens on
// "monument:open" (clicking the well). Created keepers emit "keeper:created"
// so the world refreshes and the new cottage appears.
import { createHoloPanel, ensureThinking } from "./holo/holo.js";

export function createMonument({ root, bus, api, toasts } = {}) {
  const doc = root?.ownerDocument ?? globalThis.document;
  let holo = null;
  let busy = false;

  function open() {
    if (holo) {
      holo.el.querySelector("input")?.focus();
      return;
    }
    const content = doc.createElement("div");
    content.className = "mk-monument";

    const log = doc.createElement("div");
    log.className = "mk-monument-log";
    content.appendChild(log);

    const line = (kind, text) => {
      const el = doc.createElement("div");
      el.className = `mk-monument-line is-${kind}`;
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    };
    line(
      "hint",
      "Every keeper was born from this well. Ask across all shelves, or ask for a new keeper.",
    );

    const form = doc.createElement("form");
    form.className = "mk-monument-composer";
    const input = doc.createElement("input");
    input.type = "text";
    input.placeholder = "speak to the island...";
    input.setAttribute("aria-label", "speak to the monument");
    const send = doc.createElement("button");
    send.type = "submit";
    send.textContent = "send";
    send.setAttribute("aria-label", "send to the monument");
    form.append(input, send);
    content.appendChild(form);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || busy) return;
      busy = true;
      input.value = "";
      line("you", text);
      ensureThinking(form, true);
      try {
        const out = await api.monument(text);
        line("them", out.reply || "...");
        if (out.created_keeper) {
          line("hint", `${out.created_keeper.name} has her house now.`);
          bus?.emit("keeper:created", out.created_keeper);
          toasts?.show?.(`${out.created_keeper.name} joined the island`);
        }
      } catch (err) {
        line("hint", err?.code === "KEEPERS_FULL"
          ? "No free plots remain on the light side."
          : "The well only ripples. Try again.");
      } finally {
        busy = false;
        ensureThinking(form, false);
        input.focus();
      }
    });

    holo = createHoloPanel({
      title: "the monument",
      content,
      onClose: () => (holo = null),
      className: "mk-monument-panel",
    });
    holo.el.setAttribute("aria-label", "the monument");
    root.appendChild(holo.el); // mounting starts the materialize sequence
    input.focus();
  }

  const off = bus?.on?.("monument:open", open) ?? null;
  return {
    open,
    close() {
      holo?.close();
    },
    dispose() {
      off?.();
      holo?.close();
    },
  };
}
