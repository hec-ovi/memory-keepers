// How-to-play overlay in a holo panel (ui/holo). Factory, promise-free:
// open()/close()/toggle(). Closes on Escape, the close button, or a backdrop
// click.

import { createHoloPanel } from "./holo/holo.js";

const CONTROLS = [
  ["Drag", "pan: grab the ground and drag it"],
  ["Middle-drag", "orbit around the island"],
  ["Wheel / two-finger scroll", "zoom the camera"],
  ["Click an keeper", "select her and open the talk panel (Tell / Ask)"],
  ["Click a house door", "step inside her library"],
  ["Click a book", "she picks it up so you can read it"],
  ["Minimap", "click it to jump the camera anywhere"],
  ["Esc / Back", "return to the overworld"],
];

const NOTES = [
  "Keepers keep your memories as books. Tell one something and she writes a book; ask and she reads her library back to you. Talking makes her tired: when her rest meter runs low, send her to sleep so she can dream.",
  "Across the ridge lies the unconscious quarter, where it is always night. The keepers living there are born from the dreaming. You can talk to them too: they listen and answer, but they keep no books of what you tell them.",
  "View keepers (HUD button) lists everyone on the island with her level and books; click one to visit her, or use Cross the ridge to glide over to the night quarter.",
  "Dreaming (HUD button) sends every keeper to sleep at once to dream up the connections between their books. When it finishes, watch the graph movie.",
];

export function createHowto({ root } = {}) {
  const doc = root.ownerDocument;
  let backdrop = null;
  let holo = null;
  let onKey = null;

  function close() {
    if (!backdrop) return;
    doc.removeEventListener("keydown", onKey, true);
    holo?.close();
    holo = null;
    backdrop.remove();
    backdrop = null;
    onKey = null;
  }

  function open() {
    if (backdrop) return;

    backdrop = doc.createElement("div");
    backdrop.className = "overlay-backdrop";

    const content = doc.createElement("div");
    content.className = "howto";

    const list = doc.createElement("ul");
    list.className = "howto-list";
    for (const [key, what] of CONTROLS) {
      const li = doc.createElement("li");
      const kbd = doc.createElement("span");
      kbd.className = "kbd";
      kbd.textContent = key;
      const text = doc.createElement("span");
      text.textContent = what;
      li.appendChild(kbd);
      li.appendChild(text);
      list.appendChild(li);
    }
    content.appendChild(list);

    for (const note of NOTES) {
      const p = doc.createElement("p");
      p.textContent = note;
      content.appendChild(p);
    }

    const actions = doc.createElement("div");
    actions.className = "dialog-actions";
    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "holo-btn holo-btn--primary";
    closeBtn.textContent = "Got it";
    closeBtn.addEventListener("click", close);
    actions.appendChild(closeBtn);
    content.appendChild(actions);

    holo = createHoloPanel({
      title: "How to play",
      content,
      size: "lg",
      onClose: close,
      className: "dialog",
    });
    holo.el.setAttribute("role", "dialog");
    holo.el.setAttribute("aria-modal", "true");
    const titleEl = holo.el.querySelector(".holo-panel__title");
    titleEl.id = "howto-title";
    holo.el.setAttribute("aria-labelledby", titleEl.id);

    backdrop.appendChild(holo.el);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });

    onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    doc.addEventListener("keydown", onKey, true);

    root.appendChild(backdrop);
    closeBtn.focus();
  }

  return {
    open,
    close,
    toggle: () => (backdrop ? close() : open()),
    isOpen: () => backdrop !== null,
    dispose: close,
  };
}
