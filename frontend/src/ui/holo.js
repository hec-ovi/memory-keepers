// The holo panel kit: every modal in the game materializes through this one
// module. Game-agnostic: it knows titles and bodies, never keepers or books.
export function holoPanel({ title, root, width, onClose }) {
  const el = document.createElement("div");
  el.className = "holo";
  if (width) el.style.width = width;
  el.style.left = "50%";
  el.style.top = "50%";
  el.style.transform = "translate(-50%, -50%)";

  const header = document.createElement("header");
  const titleEl = document.createElement("span");
  titleEl.textContent = title;
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const closeButton = document.createElement("button");
  closeButton.textContent = "✕";
  closeButton.setAttribute("aria-label", "close");
  header.append(titleEl, spacer, closeButton);

  const body = document.createElement("div");
  body.className = "body";
  el.append(header, body);
  (root || document.getElementById("panels") || document.body).append(el);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    el.classList.add("closing");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    removeEventListener("keydown", onKey);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  closeButton.addEventListener("click", close);
  addEventListener("keydown", onKey);

  return { el, header, body, close, setTitle: (t) => (titleEl.textContent = t) };
}

export function toast(message, root) {
  let host = (root || document).querySelector("#toast");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast";
    (root || document.body).append(host);
  }
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  host.append(item);
  setTimeout(() => item.remove(), 4200);
}
