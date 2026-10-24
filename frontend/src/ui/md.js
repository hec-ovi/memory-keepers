// Minimal markdown -> safe DOM. Supports headings, bold, italic, inline code,
// links, unordered/ordered lists and paragraphs. Raw HTML in the input is never
// parsed as HTML: all text lands in DOM text nodes, so it renders escaped.

const SAFE_HREF = /^(https?:\/\/|\.{0,2}\/|#)/i;

// Inline tokens, tried in order at each position.
const INLINE = [
  { re: /^\*\*([^*]+)\*\*/, tag: "strong" },
  { re: /^__([^_]+)__/, tag: "strong" },
  { re: /^\*([^*]+)\*/, tag: "em" },
  { re: /^_([^_]+)_/, tag: "em" },
  { re: /^`([^`]+)`/, tag: "code", raw: true },
];

const LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)\)/;

function renderInline(doc, text, parent) {
  let rest = text;
  let plain = "";
  const flush = () => {
    if (plain) {
      parent.appendChild(doc.createTextNode(plain));
      plain = "";
    }
  };
  outer: while (rest.length > 0) {
    const link = LINK_RE.exec(rest);
    if (link) {
      flush();
      const a = doc.createElement("a");
      if (SAFE_HREF.test(link[2])) {
        a.setAttribute("href", link[2]);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
      renderInline(doc, link[1], a);
      parent.appendChild(a);
      rest = rest.slice(link[0].length);
      continue;
    }
    for (const { re, tag, raw } of INLINE) {
      const m = re.exec(rest);
      if (m) {
        flush();
        const el = doc.createElement(tag);
        if (raw) el.textContent = m[1];
        else renderInline(doc, m[1], el);
        parent.appendChild(el);
        rest = rest.slice(m[0].length);
        continue outer;
      }
    }
    plain += rest[0];
    rest = rest.slice(1);
  }
  flush();
}

// Returns a DocumentFragment; append it wherever the text should show.
export function mdToDom(md, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  if (typeof md !== "string" || md.trim() === "") return frag;

  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const h = doc.createElement(`h${heading[1].length}`);
      renderInline(doc, heading[2].trim(), h);
      frag.appendChild(h);
      i++;
      continue;
    }

    const isUl = (l) => /^\s*[-*]\s+/.test(l);
    const isOl = (l) => /^\s*\d+[.)]\s+/.test(l);
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const list = doc.createElement(ordered ? "ol" : "ul");
      while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
        const li = doc.createElement("li");
        const item = lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, "");
        renderInline(doc, item, li);
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    // paragraph: consume consecutive plain lines
    const buf = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i])
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    const p = doc.createElement("p");
    renderInline(doc, buf.join(" "), p);
    frag.appendChild(p);
  }

  return frag;
}

// Convenience: render into a container (cleared first) with the .md class.
export function renderMd(container, md) {
  container.textContent = "";
  container.classList.add("md");
  container.appendChild(mdToDom(md, container.ownerDocument));
  return container;
}
