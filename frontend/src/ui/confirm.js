// Promise-based confirm dialog in a holo panel (ui/holo).
//   const confirm = createConfirm({ root });
//   const ok = await confirm.ask({ title, message, confirmLabel, cancelLabel, danger });
// Resolves true on confirm (button or Enter), false on cancel (button, Escape,
// or backdrop click). Only one dialog at a time; a second ask() while one is
// open resolves the first as cancelled.

import { createHoloPanel } from "./holo/holo.js";

export function createConfirm({ root } = {}) {
  const doc = root.ownerDocument;
  let current = null; // { backdrop, holo, resolve, onKey, previousFocus }

  function close(result) {
    if (!current) return;
    const { backdrop, holo, resolve, onKey, previousFocus } = current;
    current = null;
    doc.removeEventListener("keydown", onKey, true);
    holo.close();
    backdrop.remove();
    if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
    resolve(result);
  }

  function ask({
    title = "Are you sure?",
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
  } = {}) {
    close(false); // cancel any dialog already open

    return new Promise((resolve) => {
      const backdrop = doc.createElement("div");
      backdrop.className = "overlay-backdrop";

      const content = doc.createElement("div");

      if (message) {
        const messageEl = doc.createElement("p");
        messageEl.textContent = message;
        content.appendChild(messageEl);
      }

      const actions = doc.createElement("div");
      actions.className = "dialog-actions";

      const cancelBtn = doc.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "holo-btn";
      cancelBtn.textContent = cancelLabel;
      cancelBtn.addEventListener("click", () => close(false));

      const confirmBtn = doc.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = danger ? "holo-btn holo-btn--danger" : "holo-btn holo-btn--primary";
      confirmBtn.textContent = confirmLabel;
      confirmBtn.addEventListener("click", () => close(true));

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      content.appendChild(actions);

      const holo = createHoloPanel({
        title,
        content,
        size: "sm",
        className: "dialog",
      });
      holo.el.setAttribute("role", "dialog");
      holo.el.setAttribute("aria-modal", "true");
      const titleEl = holo.el.querySelector(".holo-panel__title");
      titleEl.id = "confirm-title";
      holo.el.setAttribute("aria-labelledby", titleEl.id);

      backdrop.appendChild(holo.el);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close(false);
      });

      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close(false);
        } else if (e.key === "Enter") {
          e.stopPropagation();
          close(true);
        }
      };
      doc.addEventListener("keydown", onKey, true);

      root.appendChild(backdrop);
      current = { backdrop, holo, resolve, onKey, previousFocus: doc.activeElement };
      confirmBtn.focus();
    });
  }

  return {
    ask,
    isOpen: () => current !== null,
    dispose() {
      close(false);
    },
  };
}
