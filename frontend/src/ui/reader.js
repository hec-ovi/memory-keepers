// Book reader panel: a holo frame (ui/holo) whose body stays a readable
// paper book page: light paper tint, ink text, drop cap. Title in the amber
// holo header, meta chips, markdown body, linked books, and a Destroy button
// behind a confirm dialog. Factory per the module contract, no module-level
// side effects:
//
//   const reader = createReader({ root, state, bus, api, toasts, confirm });
//   reader.open("dreams", "2026-07-02-flying-over-water");
//
// Bus wiring:
//   listens "book:open"      { keeperId, slug }  -> fetches and shows the book
//   emits   "book:destroyed" { keeperId, slug }  after a confirmed destroy
//   emits   "reader:closed"  whenever the panel closes (the interior scene
//           returns the floating book to its shelf and walks the keeper home)
//
// Links may point across keepers ("meetings/2026-06-30-mars-sync"); clicking one
// loads that book in place. Esc or the close button closes the reader (modal
// overlays get first dibs on Esc).

import { renderMd } from "./md.js";
import { createHoloPanel, ensureHoloStyles, injectStyle, makeEl } from "./holo/holo.js";

const STYLE_ID = "mk-reader-style";
const CSS = `
.mk-reader{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:min(680px,calc(100vw - 48px));max-height:min(82vh,760px);overflow-y:auto;z-index:40;}
.mk-reader-chips{margin-bottom:12px;}
.mk-reader-chip-date{color:var(--holo-amber-hi,#ffd9a0);}
.mk-reader-chip-source{color:var(--holo-cyan,#3fe0ff);border-color:var(--holo-cyan-dim,rgba(63,224,255,.35));}
/* The body reads like a little book page: paper tint, ink text, a drop cap.
   It stays LIGHT inside the dark holo frame for legibility. */
.mk-reader-body{background:var(--paper,#f7eedd);color:var(--paper-ink,#43334c);border-radius:4px;padding:18px 22px;box-shadow:inset 0 0 28px rgba(112,84,60,.14);font-family:var(--font,system-ui);letter-spacing:0;}
.mk-reader-body h1,.mk-reader-body h2,.mk-reader-body h3,.mk-reader-body h4,.mk-reader-body h5,.mk-reader-body h6{color:#a3552e;font-family:var(--font-display,inherit);}
.mk-reader-body a{color:#8a5a1e;}
.mk-reader-body code{background:rgba(67,51,76,.1);color:#6e4a2b;}
.mk-reader-body > p:first-of-type::first-letter{font-family:var(--font-display,inherit);font-size:2.6em;line-height:.85;float:left;padding:3px 8px 0 0;color:#c2742e;font-weight:700;}
.mk-reader-links{margin-top:14px;border-top:1px solid var(--holo-line,rgba(255,166,64,.42));padding-top:10px;}
.mk-reader-links h3{margin:0 0 6px;font-size:.72rem;text-transform:uppercase;letter-spacing:.12em;color:var(--holo-amber-dim,rgba(255,166,64,.55));}
.mk-reader-link{cursor:pointer;}
.mk-reader-foot{display:flex;justify-content:flex-end;margin-top:16px;}
.mk-reader-status{font-style:italic;opacity:.8;}
.mk-reader-skeleton{display:flex;flex-direction:column;gap:10px;margin-top:10px;}
.mk-reader-skeleton .skeleton{height:14px;}
.mk-reader-skeleton .skeleton:first-child{height:22px;width:60%;}
.mk-reader-skeleton .skeleton:last-child{width:80%;}
`;

// "meetings/2026-06-30-mars-sync" -> cross-keeper link; bare slug -> same keeper.
export function parseBookLink(link, currentKeeperId) {
  const raw = String(link ?? "");
  const slash = raw.indexOf("/");
  if (slash > 0) return { keeperId: raw.slice(0, slash), slug: raw.slice(slash + 1) };
  return { keeperId: currentKeeperId, slug: raw };
}

export function createReader({ root, state, bus, api, toasts, confirm, ui } = {}) {
  const doc = root.ownerDocument;
  const notify = toasts ?? ui?.toasts ?? null;
  const confirmer = confirm ?? ui?.confirm ?? null;
  // Kit styles first, host styles second: .mk-reader positioning must come
  // later in the cascade than the kit's .holo-panel defaults.
  ensureHoloStyles(doc);
  injectStyle(doc, STYLE_ID, CSS);

  let holo = null;
  let content = null;
  let onKey = null;
  let loadSeq = 0;
  let destroying = false;
  const offs = [];

  const el = makeEl(doc);

  function toastError(message) {
    if (notify) notify.error(message);
    else bus?.emit("toast", { message, kind: "error" });
  }

  function close() {
    if (!holo) return;
    if (onKey) doc.removeEventListener("keydown", onKey, true);
    onKey = null;
    holo.close();
    holo = null;
    content = null;
    bus?.emit("reader:closed");
  }

  function buildShell() {
    if (holo) return;
    content = el("div");
    holo = createHoloPanel({
      title: "book",
      content,
      size: null, // .mk-reader owns the footprint
      onClose: close,
      className: "mk-reader",
    });
    holo.el.setAttribute("role", "dialog");
    holo.el.setAttribute("aria-label", "book reader");
    holo.el.querySelector(".holo-close")?.setAttribute("aria-label", "close reader");

    onKey = (e) => {
      if (e.key !== "Escape") return;
      if (doc.querySelector(".overlay-backdrop")) return; // confirm owns Esc
      e.stopPropagation();
      close();
    };
    doc.addEventListener("keydown", onKey, true);

    root.appendChild(holo.el);
  }

  function renderBook(keeperId, book) {
    content.textContent = "";
    holo.setTitle(book.title || book.slug);

    const chips = el("div", "mk-reader-chips");
    if (book.date) chips.appendChild(el("span", "holo-chip chip mk-reader-chip-date", book.date));
    if (book.source) chips.appendChild(el("span", "holo-chip chip mk-reader-chip-source", book.source));
    for (const tag of book.tags ?? []) chips.appendChild(el("span", "holo-chip chip", `#${tag}`));
    for (const entity of book.entities ?? []) chips.appendChild(el("span", "holo-chip chip", entity));
    content.appendChild(chips);

    const body = el("div", "mk-reader-body");
    renderMd(body, book.body_md ?? "");
    content.appendChild(body);

    if (book.links?.length) {
      const linksBox = el("div", "mk-reader-links");
      linksBox.appendChild(el("h3", null, "linked books"));
      for (const link of book.links) {
        const btn = el("button", "holo-chip chip mk-reader-link", link);
        btn.type = "button";
        btn.addEventListener("click", () => {
          const target = parseBookLink(link, keeperId);
          open(target.keeperId, target.slug);
        });
        linksBox.appendChild(btn);
      }
      content.appendChild(linksBox);
    }

    const foot = el("div", "mk-reader-foot");
    const destroyBtn = el("button", "holo-btn holo-btn--danger", "Destroy");
    destroyBtn.type = "button";
    destroyBtn.addEventListener("click", async () => {
      if (destroying) return;
      const ok = confirmer
        ? await confirmer.ask({
            title: `Destroy "${book.title || book.slug}"?`,
            message: "The book burns and the memory is gone for good.",
            confirmLabel: "Destroy",
            danger: true,
          })
        : true;
      if (!ok) return;
      destroying = true;
      destroyBtn.disabled = true;
      try {
        await api.deleteBook(keeperId, book.slug);
        const rec = state?.keepers?.find((a) => a.id === keeperId);
        if (rec && rec.book_count > 0) rec.book_count -= 1;
        bus?.emit("book:destroyed", { keeperId, slug: book.slug });
        notify?.success?.("the book is gone");
        close();
      } catch (err) {
        toastError(err?.message || "the book refused to burn");
        destroyBtn.disabled = false;
      } finally {
        destroying = false;
      }
    });
    foot.appendChild(destroyBtn);
    content.appendChild(foot);
  }

  async function open(keeperId, slug) {
    if (!keeperId || !slug) return;
    const seq = ++loadSeq;
    buildShell();
    holo.setTitle(slug);
    content.textContent = "";
    const status = el("p", "mk-reader-status", `opening ${slug}...`);
    status.setAttribute("role", "status");
    content.appendChild(status);
    const shimmer = el("div", "mk-reader-skeleton");
    shimmer.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 4; i++) shimmer.appendChild(el("div", "skeleton"));
    content.appendChild(shimmer);
    try {
      const book = await api.getBook(keeperId, slug);
      if (seq !== loadSeq || !holo) return;
      renderBook(keeperId, book);
    } catch (err) {
      if (seq !== loadSeq) return;
      toastError(err?.message || "could not open the book");
      close();
    }
  }

  offs.push(bus?.on?.("book:open", (p) => open(p?.keeperId, p?.slug)) ?? (() => {}));

  return {
    open,
    close,
    isOpen: () => holo !== null,
    dispose() {
      close();
      for (const off of offs) off();
    },
  };
}
