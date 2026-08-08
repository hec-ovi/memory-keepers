// ui/holo/voice.js: the generic voice visualizer (central speaker icon
// wrapped by waveform strands). Pure state machine + geometry helpers tested
// directly; the canvas component with a mocked 2d context and captured rAF
// frames.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVoiceViz,
  createVoiceState,
  setVoiceMode,
  modeBlend,
  vizFrame,
  ringRadius,
  strandParams,
  speakerGeometry,
  VOICE_MODES,
  MODE_PARAMS,
  MODE_FADE_MS,
  STRAND_COUNT,
  RENDER_SCALE,
} from "../src/ui/holo/voice.js";
import { HOLO_STYLE_ID } from "../src/ui/holo/holo.js";

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  document.getElementById(HOLO_STYLE_ID)?.remove();
  document.querySelectorAll(".holo-voice").forEach((n) => n.remove());
  vi.restoreAllMocks();
});

describe("voice state machine (pure)", () => {
  it("starts idle and transitions only to known modes", () => {
    let s = createVoiceState(0);
    expect(s.mode).toBe("idle");
    s = setVoiceMode(s, "listening", 100);
    expect(s).toEqual({ mode: "listening", prev: "idle", since: 100 });
    const same = setVoiceMode(s, "listening", 200); // no-op: same mode
    expect(same).toBe(s);
    const bogus = setVoiceMode(s, "shouting", 200); // no-op: unknown mode
    expect(bogus).toBe(s);
    s = setVoiceMode(s, "speaking", 300);
    expect(s.prev).toBe("listening");
    expect(VOICE_MODES).toEqual(["idle", "listening", "speaking"]);
  });

  it("modeBlend ramps 0..1 over the fade window and clamps", () => {
    const s = setVoiceMode(createVoiceState(0), "listening", 1000);
    expect(modeBlend(s, 1000)).toBe(0);
    expect(modeBlend(s, 1000 + MODE_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(modeBlend(s, 1000 + MODE_FADE_MS * 3)).toBe(1);
    expect(modeBlend(createVoiceState(0), 5)).toBe(1); // no transition running
  });

  it("vizFrame interpolates between the previous and current mode params", () => {
    const s = setVoiceMode(createVoiceState(0), "listening", 1000);
    const atStart = vizFrame(s, 1000);
    expect(atStart.alpha).toBeCloseTo(MODE_PARAMS.idle.alpha);
    const atEnd = vizFrame(s, 1000 + MODE_FADE_MS);
    expect(atEnd.alpha).toBeCloseTo(MODE_PARAMS.listening.alpha);
    expect(atEnd.wobble).toBeCloseTo(MODE_PARAMS.listening.wobble);
    expect(atEnd.hue).toBeCloseTo(MODE_PARAMS.listening.hue);
    const mid = vizFrame(s, 1000 + MODE_FADE_MS / 2);
    expect(mid.alpha).toBeGreaterThan(atStart.alpha);
    expect(mid.alpha).toBeLessThan(atEnd.alpha);
  });

  it("mode palettes: idle is faint, listening is bright cyan, speaking is purple/blue", () => {
    // idle barely glows; the live modes burn bright
    expect(MODE_PARAMS.idle.alpha).toBeLessThan(0.35);
    expect(MODE_PARAMS.listening.alpha).toBeGreaterThan(0.8);
    expect(MODE_PARAMS.speaking.alpha).toBeGreaterThan(0.8);
    // cyan sits near 190deg; speaking is purple-centered fanning to blue
    expect(MODE_PARAMS.listening.hue).toBeGreaterThan(180);
    expect(MODE_PARAMS.listening.hue).toBeLessThan(200);
    expect(MODE_PARAMS.speaking.hue).toBeGreaterThan(240);
    expect(MODE_PARAMS.speaking.hueSpread).toBeGreaterThan(MODE_PARAMS.listening.hueSpread);
  });

  it("ringRadius wobbles around 1 within its band, deterministically", () => {
    const p = { wobble: 0.08, waves: 7, speed: 1.5 };
    for (let i = 0; i < 40; i++) {
      const theta = (i / 40) * Math.PI * 2;
      const r = ringRadius(theta, 1.234, p);
      expect(r).toBeGreaterThan(1 - 0.08 * 1.7);
      expect(r).toBeLessThan(1 + 0.08 * 1.7);
      expect(r).toBe(ringRadius(theta, 1.234, p));
    }
    // time moves the waves
    expect(ringRadius(1, 0, p)).not.toBe(ringRadius(1, 2, p));
  });

  it("has 5 to 7 strands, concentric and de-phased, outer ones fainter", () => {
    expect(STRAND_COUNT).toBeGreaterThanOrEqual(5);
    expect(STRAND_COUNT).toBeLessThanOrEqual(7);
    let prev = null;
    for (let i = 0; i < STRAND_COUNT; i++) {
      const s = strandParams(i);
      expect(s).toEqual(strandParams(i)); // deterministic
      if (prev) {
        expect(s.radius).toBeGreaterThan(prev.radius); // concentric spread
        expect(s.alphaMul).toBeLessThan(prev.alphaMul); // outer strands fainter
        expect(s.phase).not.toBe(prev.phase); // de-phased wobble
      }
      expect(s.hueT).toBeGreaterThanOrEqual(0);
      expect(s.hueT).toBeLessThanOrEqual(1);
      prev = s;
    }
  });

  it("speakerGeometry: one centered icon (box, cone, two arcs) scaling with size", () => {
    const g = speakerGeometry(160);
    expect(g.body.w).toBeGreaterThan(0);
    expect(g.body.h).toBeGreaterThan(g.body.w); // driver box is taller than wide
    expect(g.cone).toHaveLength(4);
    expect(g.arcs).toHaveLength(2);
    expect(g.arcs[1].r).toBeGreaterThan(g.arcs[0].r); // arcs radiate outward
    // roughly centered in the canvas
    const xs = g.cone.map(([x]) => x);
    expect(Math.min(...xs)).toBeGreaterThan(160 * 0.2);
    expect(Math.max(...xs)).toBeLessThan(160 * 0.8);
    // linear scale: double the size doubles the geometry
    const big = speakerGeometry(320);
    expect(big.body.w).toBeCloseTo(g.body.w * 2);
    expect(big.arcs[0].r).toBeCloseTo(g.arcs[0].r * 2);
  });
});

describe("createVoiceViz", () => {
  it("mounts a holo-voice element in idle and switches modes via data-mode", () => {
    const viz = createVoiceViz({ size: 120 });
    document.body.appendChild(viz.el);
    expect(viz.el.classList.contains("holo-voice")).toBe(true);
    expect(viz.el.dataset.mode).toBe("idle");
    expect(viz.el.querySelector("canvas")).toBeTruthy();

    viz.setMode("listening");
    expect(viz.el.dataset.mode).toBe("listening");
    expect(viz.getMode()).toBe("listening");
    viz.setMode("nonsense"); // ignored
    expect(viz.el.dataset.mode).toBe("listening");
    viz.setMode("speaking");
    expect(viz.el.dataset.mode).toBe("speaking");
    viz.dispose();
  });

  it("renders at 2x for a crisp icon: backing store doubled, CSS size kept", () => {
    const viz = createVoiceViz({ size: 120 });
    const canvas = viz.el.querySelector("canvas");
    expect(RENDER_SCALE).toBe(2);
    expect(canvas.width).toBe(120 * RENDER_SCALE);
    expect(canvas.height).toBe(120 * RENDER_SCALE);
    expect(canvas.style.width).toBe("120px");
    expect(canvas.style.height).toBe("120px");
    viz.dispose();
  });

  it("survives jsdom's null 2d context (no draw loop, still functional)", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const viz = createVoiceViz({ size: 80 });
    expect(rafSpy).not.toHaveBeenCalled(); // nothing to draw on
    expect(() => viz.setMode("speaking")).not.toThrow();
    viz.dispose();
  });

  it("draws strands + speaker icon each frame in every mode, dispose cancels rAF", () => {
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
    };
    HTMLCanvasElement.prototype.getContext.mockReturnValue(ctx);
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
    const cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const viz = createVoiceViz({ size: 100 });
    document.body.appendChild(viz.el);
    expect(rafSpy).toHaveBeenCalledTimes(1);
    const draw = rafSpy.mock.calls[0][0];

    draw(16); // idle: faint strands + dim icon
    expect(ctx.setTransform).toHaveBeenCalledWith(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
    const idleStrokes = ctx.stroke.mock.calls.length;
    // strands (STRAND_COUNT rings) + the icon's two arcs
    expect(idleStrokes).toBe(STRAND_COUNT + 2);
    expect(ctx.fill).toHaveBeenCalledTimes(2); // icon body + cone
    expect(ctx.arc).toHaveBeenCalledTimes(2); // icon sound arcs

    ctx.stroke.mockClear();
    ctx.fill.mockClear();
    viz.setMode("speaking");
    draw((performance?.now?.() ?? Date.now()) + MODE_FADE_MS * 4); // blend done
    expect(ctx.stroke.mock.calls.length).toBe(STRAND_COUNT + 2); // rings stay rings
    expect(ctx.fill).toHaveBeenCalledTimes(2); // icon still crisp

    viz.dispose();
    expect(cafSpy).toHaveBeenCalled();
    expect(document.querySelector(".holo-voice")).toBeNull();
    expect(() => viz.dispose()).not.toThrow(); // idempotent
  });
});
