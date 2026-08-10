// Modal form for creating a conscious keeper, in a holo panel (ui/holo): topic
// (required, live lowercase slug preview), optional name and persona. Factory
// per the module contract, no module-level side effects:
//
//   const creator = createCreateKeeper({ root, state, bus, api, toasts });
//   creator.open(); creator.close();
//
// Bus wiring:
//   listens "create_keeper:open"          -> opens the modal (the HUD emits this)
//   emits   "keeper:created"  (the Keeper)  on success (also pushed into state.keepers)
//
// Submit stays disabled while the topic slugs to nothing or a request is in
// flight. A 409 KEEPER_EXISTS shows an inline error; a 409 KEEPERS_FULL (every
// village plot is taken) shows a friendly inline message; other failures
// toast. Esc, Cancel, or a backdrop click closes the modal.

import { createHoloPanel } from "./holo/holo.js";

const STYLE_ID = "mk-create-style";
const CSS = `
.mk-create-form{min-width:min(380px,calc(100vw - 64px));}
.mk-create-slug{font-size:.82rem;color:var(--text-dim,#c99a66);margin:6px 0 0;}
.mk-create-slug code{color:var(--holo-cyan,#3fe0ff);background:rgba(10,5,2,.75);border-radius:4px;padding:1px 6px;}
.mk-create-form textarea{resize:vertical;min-height:70px;}
`;

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

// Lowercase slug, the same shape the engine derives ids from.
export function slugify(topic) {
  return String(topic ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createCreateKeeper({ root, state, bus, api, toasts, ui } = {}) {
  const doc = root.ownerDocument;
  const notify = toasts ?? ui?.toasts ?? null;
  ensureStyles(doc);

  let backdrop = null;
  let holo = null;
  let onKey = null;
  let inFlight = false;
  const offs = [];

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function toastError(message) {
    if (notify) notify.error(message);
    else bus?.emit("toast", { message, kind: "error" });
  }

  function close() {
    if (!backdrop) return;
    doc.removeEventListener("keydown", onKey, true);
    onKey = null;
    holo?.close();
    holo = null;
    backdrop.remove();
    backdrop = null;
    inFlight = false;
  }

  function open() {
    if (backdrop) return;

    backdrop = el("div", "overlay-backdrop");

    const form = el("form", "mk-create-form");

    const field = (labelText, control) => {
      const label = el("label", "field-label", labelText);
      const id = `mk-create-${labelText.toLowerCase().replace(/[^a-z]+/g, "-")}`;
      label.setAttribute("for", id);
      control.id = id;
      form.appendChild(label);
      form.appendChild(control);
      return control;
    };

    const topicInput = doc.createElement("input");
    topicInput.className = "holo-input input";
    topicInput.type = "text";
    topicInput.placeholder = "dreams, meetings, films i watched...";
    field("Topic", topicInput);

    const slugPreview = el("p", "mk-create-slug");
    const slugCode = el("code", null, "...");
    slugPreview.append("she will live at /keepers/", slugCode);
    form.appendChild(slugPreview);

    let errorEl = null;
    const showError = (message) => {
      clearError();
      errorEl = el("p", "field-error", message);
      slugPreview.after(errorEl);
    };
    const clearError = () => {
      errorEl?.remove();
      errorEl = null;
    };

    const nameInput = doc.createElement("input");
    nameInput.className = "holo-input input";
    nameInput.type = "text";
    nameInput.placeholder = "Keeper of Dreams";
    field("Name (optional)", nameInput);

    const personaInput = doc.createElement("textarea");
    personaInput.className = "holo-input input";
    personaInput.placeholder = "Keeper of the user's dreams. Speaks softly...";
    field("Persona (optional)", personaInput);

    const actions = el("div", "dialog-actions");
    const cancelBtn = el("button", "holo-btn", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", close);
    const submitBtn = el("button", "holo-btn holo-btn--primary", "Create");
    submitBtn.type = "submit";
    submitBtn.disabled = true;
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    form.appendChild(actions);

    const sync = () => {
      const slug = slugify(topicInput.value);
      slugCode.textContent = slug || "...";
      submitBtn.disabled = inFlight || slug === "";
    };
    topicInput.addEventListener("input", () => {
      clearError();
      sync();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const topic = slugify(topicInput.value);
      if (!topic || inFlight) return;
      inFlight = true;
      sync();
      clearError();
      const name = nameInput.value.trim();
      const persona = personaInput.value.trim();
      try {
        const keeper = await api.createKeeper({
          topic,
          ...(name && { name }),
          ...(persona && { persona }),
        });
        if (Array.isArray(state?.keepers) && keeper?.id && !state.keepers.some((a) => a.id === keeper.id)) {
          state.keepers.push(keeper);
        }
        bus?.emit("keeper:created", keeper);
        notify?.success?.(`${keeper?.name || topic} moved in`);
        close();
      } catch (err) {
        inFlight = false;
        if (err?.code === "KEEPERS_FULL") {
          showError("the village has no free plots yet; every house is lived in");
        } else if (err?.status === 409 || err?.code === "KEEPER_EXISTS") {
          showError(err?.message || "a keeper for this topic already exists");
        } else {
          toastError(err?.message || "she could not move in");
        }
        if (backdrop) sync();
      }
    });

    holo = createHoloPanel({
      title: "A new keeper moves in",
      content: form,
      size: null, // the form sets its own min-width
      onClose: close,
      className: "dialog mk-create",
    });
    holo.el.setAttribute("role", "dialog");
    holo.el.setAttribute("aria-modal", "true");
    const titleEl = holo.el.querySelector(".holo-panel__title");
    titleEl.id = "mk-create-title";
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
    topicInput.focus();
  }

  offs.push(bus?.on?.("create_keeper:open", open) ?? (() => {}));

  return {
    open,
    close,
    isOpen: () => backdrop !== null,
    dispose() {
      close();
      for (const off of offs) off();
    },
  };
}
