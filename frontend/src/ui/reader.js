// The book reader: one book, its metadata and body, and the destroy action.
import { holoPanel } from "./holo.js";

export function openReader(book, { root, onDelete } = {}) {
  const panel = holoPanel({ title: book.title, root, width: "440px" });
  const meta = document.createElement("div");
  meta.className = "reader-meta";
  meta.textContent = [
    book.date, book.source,
    book.tags?.length ? "tags: " + book.tags.join(", ") : "",
    book.entities?.length ? "mentions: " + book.entities.join(", ") : "",
  ].filter(Boolean).join("  ·  ");

  const body = document.createElement("div");
  body.className = "reader-body";
  for (const block of String(book.body_md || "").split(/\n{2,}|\n(?=## )/)) {
    if (block.startsWith("## ")) {
      const h = document.createElement("h2");
      h.textContent = block.slice(3);
      body.append(h);
    } else if (block.trim()) {
      const p = document.createElement("p");
      p.textContent = block;
      body.append(p);
    }
  }
  panel.body.append(meta, body);

  if (onDelete) {
    const destroy = document.createElement("button");
    destroy.className = "hud-btn danger";
    destroy.style.margin = "12px 14px";
    destroy.textContent = "destroy this book";
    destroy.addEventListener("click", async () => {
      await onDelete(book);
      panel.close();
    });
    panel.el.append(destroy);
  }
  return panel;
}
