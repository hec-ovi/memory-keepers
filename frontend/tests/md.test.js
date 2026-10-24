import { describe, expect, it } from "vitest";
import { mdToDom, renderMd } from "../src/ui/md.js";

function render(md) {
  const div = document.createElement("div");
  div.appendChild(mdToDom(md));
  return div;
}

describe("mdToDom", () => {
  it("renders headings h1-h6", () => {
    const el = render("# One\n\n### Three\n\n###### Six");
    expect(el.querySelector("h1").textContent).toBe("One");
    expect(el.querySelector("h3").textContent).toBe("Three");
    expect(el.querySelector("h6").textContent).toBe("Six");
  });

  it("renders paragraphs, joining consecutive lines", () => {
    const el = render("first line\nsecond line\n\nnext para");
    const ps = el.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    expect(ps[0].textContent).toBe("first line second line");
    expect(ps[1].textContent).toBe("next para");
  });

  it("renders bold and italic inline", () => {
    const el = render("a **bold** and *slanted* word");
    expect(el.querySelector("strong").textContent).toBe("bold");
    expect(el.querySelector("em").textContent).toBe("slanted");
    expect(el.textContent).toBe("a bold and slanted word");
  });

  it("renders inline code literally", () => {
    const el = render("run `npm test` now");
    expect(el.querySelector("code").textContent).toBe("npm test");
  });

  it("renders unordered lists", () => {
    const el = render("- flying\n- ocean\n* stars");
    const items = el.querySelectorAll("ul li");
    expect([...items].map((li) => li.textContent)).toEqual(["flying", "ocean", "stars"]);
  });

  it("renders ordered lists", () => {
    const el = render("1. wake\n2. dream");
    const items = el.querySelectorAll("ol li");
    expect([...items].map((li) => li.textContent)).toEqual(["wake", "dream"]);
  });

  it("renders links with safe hrefs and rel=noopener", () => {
    const el = render("see [the docs](https://example.com/x)");
    const a = el.querySelector("a");
    expect(a.getAttribute("href")).toBe("https://example.com/x");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.textContent).toBe("the docs");
  });

  it("drops javascript: hrefs but keeps the link text", () => {
    // eslint-disable-next-line no-script-url
    const el = render("[click me](javascript:alert(1))");
    const a = el.querySelector("a");
    expect(a.hasAttribute("href")).toBe(false);
    expect(a.textContent).toBe("click me");
  });

  it("escapes raw HTML instead of parsing it", () => {
    const el = render('<img src=x onerror="window.pwned=1"> and <b>bold?</b>');
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="window.pwned=1">');
    expect(window.pwned).toBeUndefined();
  });

  it("escapes HTML inside headings, lists and emphasis", () => {
    const el = render("# <script>1</script>\n\n- <i>x</i>\n\n**<u>y</u>**");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("i")).toBeNull();
    expect(el.querySelector("u")).toBeNull();
    expect(el.querySelector("h1").textContent).toBe("<script>1</script>");
    expect(el.querySelector("li").textContent).toBe("<i>x</i>");
    expect(el.querySelector("strong").textContent).toBe("<u>y</u>");
  });

  it("returns an empty fragment for empty or non-string input", () => {
    expect(render("").childNodes).toHaveLength(0);
    expect(render("   \n  ").childNodes).toHaveLength(0);
    expect(render(null).childNodes).toHaveLength(0);
  });
});

describe("renderMd", () => {
  it("clears the container, adds the md class and renders", () => {
    const div = document.createElement("div");
    div.textContent = "old stuff";
    renderMd(div, "# fresh");
    expect(div.classList.contains("md")).toBe(true);
    expect(div.textContent).toBe("fresh");
    expect(div.querySelector("h1")).not.toBeNull();
  });
});
