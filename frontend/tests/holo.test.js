// ui/holo/holo.js + ui/holo/shards.js: the isolated holographic panel kit.
// Panel lifecycle runs on fake timers; the shard math is pure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/dom";
import {
  createHoloPanel,
  ensureHoloStyles,
  ensureThinking,
  prefersReducedMotion,
  HOLO_STYLE_ID,
  HOLO_CLASSES,
  HOLO_OPEN_MS,
  HOLO_THINKING_CLASS,
} from "../src/ui/holo/holo.js";
import {
  tessellate,
  shardPlan,
  shardState,
  mulberry32,
  runShards,
  SHARD_COLORS,
} from "../src/ui/holo/shards.js";

let root;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  // jsdom has no canvas backend; the kit must tolerate a null 2d context.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  root.remove();
  document.getElementById(HOLO_STYLE_ID)?.remove();
  document.querySelectorAll(".holo-shards").forEach((c) => c.remove());
  delete window.matchMedia;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeContent(text = "hello content") {
  const div = document.createElement("div");
  const p = document.createElement("p");
  p.textContent = text;
  div.appendChild(p);
  return div;
}

describe("createHoloPanel", () => {
  it("mounts title + content immediately and reaches 'open' after the materialize phases", () => {
    vi.useFakeTimers();
    const panel = createHoloPanel({ title: "Nav Panel", content: makeContent() });
    root.appendChild(panel.el);

    // content and title are queryable from t=0 (phase 3 only fades opacity)
    expect(panel.el.dataset.holoState).toBe("materializing");
    expect(panel.el.classList.contains("holo-panel")).toBe(true);
    expect(panel.el.classList.contains("holo-panel--materializing")).toBe(true);
    expect(within(panel.el).getByRole("heading", { name: "Nav Panel" })).toBeTruthy();
    expect(within(panel.el).getByText("hello content")).toBeTruthy();

    vi.advanceTimersByTime(HOLO_OPEN_MS.skin + 5);
    expect(panel.el.classList.contains("holo-panel--skin")).toBe(true); // chrome snapped in

    vi.advanceTimersByTime(HOLO_OPEN_MS.total);
    expect(panel.el.dataset.holoState).toBe("open");
    expect(panel.el.classList.contains("holo-panel--ready")).toBe(true); // content faded in
    expect(panel.el.classList.contains("holo-panel--materializing")).toBe(false);
    expect(document.querySelector(".holo-shards")).toBeNull(); // overlay cleaned up
  });

  it("close() removes the panel synchronously and is idempotent", () => {
    vi.useFakeTimers();
    const panel = createHoloPanel({ title: "t", content: makeContent() });
    root.appendChild(panel.el);
    panel.close();
    expect(root.contains(panel.el)).toBe(false);
    expect(panel.el.dataset.holoState).toBe("closed");
    expect(() => panel.close()).not.toThrow();
    // pending open timers were cancelled: advancing does not resurrect state
    vi.advanceTimersByTime(2000);
    expect(panel.el.dataset.holoState).toBe("closed");
  });

  it("the header close button calls onClose (host owns the actual close)", () => {
    const onClose = vi.fn();
    const panel = createHoloPanel({ title: "t", content: makeContent(), onClose });
    root.appendChild(panel.el);
    panel.el.querySelector(".holo-close").click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(root.contains(panel.el)).toBe(true); // kit did not close by itself
    panel.close();
  });

  it("omits the header close button when no onClose is given", () => {
    const panel = createHoloPanel({ title: "t", content: makeContent() });
    expect(panel.el.querySelector(".holo-close")).toBeNull();
  });

  it("setTitle updates the header", () => {
    const panel = createHoloPanel({ title: "before", content: makeContent() });
    root.appendChild(panel.el);
    panel.setTitle("after");
    expect(within(panel.el).getByRole("heading", { name: "after" })).toBeTruthy();
  });

  it("prefers-reduced-motion falls back to a plain fade (no shard phases)", () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    expect(prefersReducedMotion(window)).toBe(true);
    const panel = createHoloPanel({ title: "t", content: makeContent() });
    root.appendChild(panel.el);
    expect(panel.el.classList.contains("holo-panel--reduced")).toBe(true);
    expect(panel.el.classList.contains("holo-panel--ready")).toBe(true); // instantly readable
    vi.advanceTimersByTime(30);
    expect(panel.el.dataset.holoState).toBe("open");
    expect(document.querySelector(".holo-shards")).toBeNull();
  });

  it("applies className and size presets / explicit sizes", () => {
    const a = createHoloPanel({ content: makeContent(), className: "my-panel", size: "sm" });
    expect(a.el.classList.contains("my-panel")).toBe(true);
    expect(a.el.style.maxWidth).toContain("340px");
    const b = createHoloPanel({ content: makeContent(), size: { width: 200, height: "50vh" } });
    expect(b.el.style.width).toBe("200px");
    expect(b.el.style.height).toBe("50vh");
    const c = createHoloPanel({ content: makeContent(), size: null });
    expect(c.el.style.width).toBe("");
    expect(c.el.style.maxWidth).toBe("");
  });

  it("injects one stylesheet defining every pinned holo class", () => {
    createHoloPanel({ content: makeContent() });
    createHoloPanel({ content: makeContent() });
    const styles = document.querySelectorAll(`#${HOLO_STYLE_ID}`);
    expect(styles).toHaveLength(1);
    const css = styles[0].textContent;
    const pinned = [
      "holo-panel",
      "holo-btn",
      "holo-btn--primary",
      "holo-tab",
      "holo-tab--active",
      "holo-list",
      "holo-row",
      "holo-chip",
      "holo-input",
    ];
    for (const cls of pinned) {
      expect(HOLO_CLASSES).toContain(cls);
      expect(css.includes(`.${cls}`), `.${cls} missing from kit CSS`).toBe(true);
    }
    // theming variables are exposed
    for (const v of ["--holo-amber", "--holo-cyan", "--holo-bg", "--holo-line", "--holo-font"]) {
      expect(css.includes(v), `${v} missing from kit CSS`).toBe(true);
    }
  });

  it("ensureHoloStyles is callable standalone (non-kit surfaces reuse classes)", () => {
    ensureHoloStyles(document);
    expect(document.getElementById(HOLO_STYLE_ID)).toBeTruthy();
  });

  it("declares the shell's position at zero specificity so hosts can reposition with one class", () => {
    // The kit must never win a positioning fight against its host: hosts
    // anchor panels with single-class rules (.mk-dialog{position:absolute}),
    // so the kit default lives in :where() (specificity 0) and the styled
    // .holo-panel block itself carries no position.
    ensureHoloStyles(document);
    const css = document.getElementById(HOLO_STYLE_ID).textContent;
    expect(css).toContain(":where(.holo-panel){position:relative;}");
    const shellBlock = css.match(/(^|\n)\.holo-panel\{[^}]*\}/)?.[0] ?? "";
    expect(shellBlock).not.toContain("position:");
  });
});

describe("ensureThinking (thinking border)", () => {
  it("toggles the holo-thinking class and injects the kit stylesheet", () => {
    const target = document.createElement("div");
    root.appendChild(target);

    expect(ensureThinking(target, true)).toBe(target);
    expect(target.classList.contains(HOLO_THINKING_CLASS)).toBe(true);
    expect(document.getElementById(HOLO_STYLE_ID)).toBeTruthy();

    ensureThinking(target, false);
    expect(target.classList.contains(HOLO_THINKING_CLASS)).toBe(false);

    // default second argument turns it on
    ensureThinking(target);
    expect(target.classList.contains(HOLO_THINKING_CLASS)).toBe(true);
  });

  it("is a no-op on null and never throws", () => {
    expect(ensureThinking(null, true)).toBe(null);
    expect(ensureThinking(undefined)).toBe(undefined);
  });

  it("styles a CSS-only conic-gradient sweep with a reduced-motion pulse fallback", () => {
    ensureHoloStyles(document);
    const css = document.getElementById(HOLO_STYLE_ID).textContent;
    expect(HOLO_CLASSES).toContain("holo-thinking");
    // the spinning multicolor ring: conic gradient over the animated angle
    expect(css).toContain(".holo-thinking::before,.holo-thinking::after");
    expect(css).toMatch(/conic-gradient\(from var\(--holo-think-a/);
    expect(css).toContain("@keyframes holo-think-spin{to{--holo-think-a:360deg;}}");
    // amber/cyan/magenta sweep
    expect(css).toMatch(/--holo-amber\).*--holo-cyan\).*--holo-magenta/s);
    // soft glow layer
    expect(css).toMatch(/\.holo-thinking::after\{[^}]*blur\(/);
    // reduced motion: no sweep, pulsing border instead
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(reduced).toContain(".holo-thinking::before,.holo-thinking::after{animation:holo-think-pulse");
  });
});

describe("shards (pure math)", () => {
  it("tessellate fills the rect with 2 triangles per grid cell, deterministically", () => {
    const tris = tessellate(260, 130, 26);
    expect(tris).toHaveLength(10 * 5 * 2);
    for (const t of tris) {
      expect(t.points).toHaveLength(3);
      // centroid inside the rect
      expect(t.cx).toBeGreaterThanOrEqual(0);
      expect(t.cx).toBeLessThanOrEqual(260);
      expect(t.cy).toBeGreaterThanOrEqual(0);
      expect(t.cy).toBeLessThanOrEqual(130);
    }
    expect(tessellate(260, 130, 26)).toEqual(tris);
  });

  it("shardPlan scatters deterministically per seed with teal/white/amber strokes", () => {
    const tris = tessellate(200, 100, 25);
    const a = shardPlan(tris, { seed: 3, width: 200, height: 100 });
    const b = shardPlan(tris, { seed: 3, width: 200, height: 100 });
    const c = shardPlan(tris, { seed: 4, width: 200, height: 100 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const p of a) {
      expect(SHARD_COLORS).toContain(p.color);
      expect(p.delay).toBeGreaterThanOrEqual(0);
      expect(p.delay).toBeLessThan(0.36);
      expect(Math.hypot(p.dx, p.dy)).toBeGreaterThan(0);
    }
  });

  it("shardState flies from scattered (t=0) to seated (t=1)", () => {
    const plan = { dx: 120, dy: -60, rot: 1.2, delay: 0.2, color: "#fff" };
    const start = shardState(plan, 0);
    expect(start.offX).toBeCloseTo(120);
    expect(start.offY).toBeCloseTo(-60);
    expect(start.alpha).toBe(0); // not yet launched (before its delay)
    const end = shardState(plan, 1);
    expect(end.offX).toBeCloseTo(0);
    expect(end.offY).toBeCloseTo(0);
    expect(end.rot).toBeCloseTo(0);
    expect(end.alpha).toBe(1);
    const mid = shardState(plan, 0.5);
    expect(Math.abs(mid.offX)).toBeLessThan(120);
    expect(Math.abs(mid.offX)).toBeGreaterThan(0);
  });

  it("mulberry32 is deterministic and in [0,1)", () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 50; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("runShards degrades to an immediate onDone without a 2d context", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 100;
    const onDone = vi.fn();
    const run = runShards(canvas, { mode: "in", duration: 100, win: window, onDone });
    expect(onDone).toHaveBeenCalledTimes(1); // jsdom: getContext mocked to null
    run.cancel();
    expect(onDone).toHaveBeenCalledTimes(1); // never twice
  });

  it("runShards draws frames when a 2d context exists", () => {
    const ctx = {
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
    };
    HTMLCanvasElement.prototype.getContext.mockReturnValue(ctx);
    const frames = [];
    const win = {
      requestAnimationFrame: vi.fn((cb) => {
        frames.push(cb);
        return frames.length;
      }),
      cancelAnimationFrame: vi.fn(),
    };
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    const onDone = vi.fn();
    runShards(canvas, { mode: "in", duration: 100, win, onDone });
    frames.shift()(0); // first frame: everything still scattered/dim
    expect(ctx.clearRect).toHaveBeenCalled();
    frames.shift()(60); // mid-flight: shards visible
    expect(ctx.stroke).toHaveBeenCalled();
    frames.shift()(120); // past duration: final frame, done
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0); // no further frames scheduled
  });
});
