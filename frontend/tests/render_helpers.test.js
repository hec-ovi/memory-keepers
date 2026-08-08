// Pure helpers exposed by the render/ modules (render/ is exempt from DOM
// tests, but its math is not exempt from tests).
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  hexToRgb,
  rgbToHex,
  mixHex,
  lightenHex,
  darkenHex,
  derivePalette,
  hopPose,
  blinkOpenness,
  breathScale,
  tiredLevelFor,
  eyelidPose,
  tiredHopHz,
  zzzPulse,
  TIRED_STATUS,
  createKeeperMesh,
  KEEPER_PINK,
} from "../src/render/keeper_mesh.js";
import { wrapBubbleText, popScale, bubbleSeconds, createSpeech } from "../src/render/speech.js";
import { frameLerp } from "../src/render/camera.js";
import * as THREE from "three";

const luminance = (hex) => {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("render/keeper_mesh color helpers", () => {
  it("hex round-trips and mixes linearly", () => {
    expect(rgbToHex(hexToRgb(0xf8a7c0))).toBe(0xf8a7c0);
    expect(mixHex(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mixHex(0x112233, 0x112233, 0.7)).toBe(0x112233);
    expect(lightenHex(0x000000, 1)).toBe(0xffffff);
    expect(darkenHex(0xffffff, 1)).toBe(0x000000);
  });

  it("accepts #rrggbb strings", () => {
    expect(rgbToHex(hexToRgb("#f8a7c0"))).toBe(0xf8a7c0);
  });
});

describe("render/keeper_mesh derivePalette", () => {
  const palette = { primary: "#f8a7c0", accent: "#7c4a6b" };

  it("is deterministic", () => {
    expect(derivePalette(palette, "conscious")).toEqual(derivePalette(palette, "conscious"));
  });

  it("conscious keepers are opaque, with a lighter top than bottom", () => {
    const p = derivePalette(palette, "conscious");
    expect(p.opacity).toBe(1);
    expect(luminance(p.top)).toBeGreaterThan(luminance(p.bottom));
    expect(luminance(p.eye)).toBeLessThan(luminance(p.top)); // dark glossy eyes
  });

  it("unconscious variant is darker but fully OPAQUE (only the tint marks her)", () => {
    const c = derivePalette(palette, "conscious");
    const u = derivePalette(palette, "unconscious");
    expect(u.opacity).toBe(1); // owner feedback: no more body transparency
    expect(luminance(u.top)).toBeLessThan(luminance(c.top));
    expect(luminance(u.eye)).toBeLessThan(luminance(c.eye));
  });

  it("an unconscious mesh renders opaque materials (no transparency flags)", () => {
    const mesh = createKeeperMesh({ keeper: { id: "fear", kind: "unconscious" } });
    let translucent = 0;
    mesh.group.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (o.name === "zzz") continue; // the Zzz sprite fades by design
        if (m.transparent && m.opacity < 1) translucent++;
      }
    });
    expect(translucent).toBe(0);
    mesh.dispose();
  });

  it("ignores Keeper.palette: every conscious keeper gets the same body pink", () => {
    const pink = derivePalette({ primary: "#f8a7c0", accent: "#7c4a6b" });
    const blue = derivePalette({ primary: "#7ca7f8", accent: "#123456" });
    const none = derivePalette(undefined);
    expect(blue).toEqual(pink);
    expect(none).toEqual(pink);
    expect(pink.top).toBe(lightenHex(KEEPER_PINK, 0.3)); // anchored to sample/keeper.png pink
  });

  it("unconscious variants are unified too", () => {
    expect(derivePalette({ primary: "#7ca7f8" }, "unconscious")).toEqual(
      derivePalette({ primary: "#f8a7c0" }, "unconscious"),
    );
  });

  it("falls back to defaults when the palette is missing", () => {
    expect(() => derivePalette(undefined)).not.toThrow();
    expect(derivePalette(undefined).opacity).toBe(1);
  });
});

describe("render/keeper_mesh hop + blink + breath curves", () => {
  it("hopPose: grounded squish at contact, airborne arc after", () => {
    const contactPose = hopPose(0.11, { contact: 0.22, squash: 0.2 });
    expect(contactPose.airborne).toBe(false);
    expect(contactPose.y).toBe(0);
    expect(contactPose.scaleY).toBeLessThan(1); // squished into the ground

    const apex = hopPose(0.22 + (1 - 0.22) / 2, { height: 0.25, contact: 0.22 });
    expect(apex.airborne).toBe(true);
    expect(apex.y).toBeCloseTo(0.25, 5);
    expect(apex.scaleY).toBeGreaterThan(1); // stretched mid-air
  });

  it("hopPose preserves volume and never NaNs across (and beyond) the cycle", () => {
    for (let u = -2; u <= 2.001; u += 0.01) {
      const p = hopPose(u);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.scaleY * p.scaleXZ * p.scaleXZ).toBeCloseTo(1, 6);
    }
  });

  it("blinkOpenness: open at the ends, shut in the middle, clamped", () => {
    expect(blinkOpenness(0)).toBeCloseTo(1, 9);
    expect(blinkOpenness(1)).toBeCloseTo(1, 9);
    expect(blinkOpenness(0.5)).toBeCloseTo(0.06, 5); // floor, never negative
    expect(blinkOpenness(-3)).toBeCloseTo(1, 9); // clamped below
    expect(blinkOpenness(9)).toBeCloseTo(1, 9); // clamped above
  });

  it("breathScale oscillates gently around 1", () => {
    let min = Infinity;
    let max = -Infinity;
    for (let t = 0; t < 10; t += 0.05) {
      const s = breathScale(t);
      min = Math.min(min, s);
      max = Math.max(max, s);
    }
    expect(min).toBeGreaterThan(0.97);
    expect(max).toBeLessThan(1.03);
    expect(max).toBeGreaterThan(1.005); // it does actually breathe
  });
});

describe("render/keeper_mesh session fatigue helpers", () => {
  it("tiredLevelFor maps session status to a level and tolerates anything", () => {
    expect(tiredLevelFor({ session: { status: "rested" } })).toBe(0);
    expect(tiredLevelFor({ session: { status: "unrested" } })).toBe(1);
    expect(tiredLevelFor({ session: { status: "needs_sleep" } })).toBe(2);
    expect(tiredLevelFor({ status: "unrested" })).toBe(1); // bare session
    expect(tiredLevelFor("needs_sleep")).toBe(2); // bare status string
    expect(tiredLevelFor(1)).toBe(1); // numeric passthrough, clamped
    expect(tiredLevelFor(9)).toBe(2);
    expect(tiredLevelFor(-3)).toBe(0);
    expect(tiredLevelFor(undefined)).toBe(0);
    expect(tiredLevelFor(null)).toBe(0);
    expect(tiredLevelFor({})).toBe(0);
    expect(tiredLevelFor("wired")).toBe(0); // unknown status reads rested
    expect(TIRED_STATUS.needs_sleep).toBe(2);
  });

  it("eyelidPose droops monotonically: open at 0, heaviest at 2", () => {
    expect(eyelidPose(0)).toEqual({ lid: 1, offsetY: -0 });
    const l0 = eyelidPose(0);
    const l1 = eyelidPose(1);
    const l2 = eyelidPose(2);
    expect(l1.lid).toBeLessThan(l0.lid);
    expect(l2.lid).toBeLessThan(l1.lid);
    expect(l2.lid).toBeGreaterThan(0.4); // droopy, never shut (that is sleeping)
    expect(l1.offsetY).toBeLessThan(0); // lids slide down
    expect(l2.offsetY).toBeLessThan(l1.offsetY);
    expect(eyelidPose(99).lid).toBe(eyelidPose(2).lid); // clamped
    expect(eyelidPose(Number.NaN).lid).toBe(1);
  });

  it("tiredHopHz slows the hop slightly per level, never drastically", () => {
    const base = tiredHopHz(0);
    expect(base).toBeCloseTo(2.2);
    expect(tiredHopHz(1)).toBeLessThan(base);
    expect(tiredHopHz(2)).toBeLessThan(tiredHopHz(1));
    expect(tiredHopHz(2)).toBeGreaterThan(base * 0.7); // slightly slower, still a hop
    expect(tiredHopHz(5)).toBe(tiredHopHz(2)); // clamped
    expect(tiredHopHz(1, 3)).toBeCloseTo(3 * (1 - 0.11));
  });

  it("zzzPulse breathes: visible all cycle, scale and lift bounded", () => {
    for (let t = 0; t < 6; t += 0.1) {
      const p = zzzPulse(t);
      expect(p.opacity).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(p.opacity).toBeLessThanOrEqual(0.85 + 1e-9);
      expect(p.scale).toBeGreaterThanOrEqual(0.85 - 1e-9);
      expect(p.scale).toBeLessThanOrEqual(1.15 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(0.13);
    }
    expect(zzzPulse(1.3).opacity).toBeGreaterThan(zzzPulse(0).opacity); // mid-cycle peak
  });
});

describe("render/keeper_mesh setTired / setSleeping (headless mesh)", () => {
  beforeEach(() => {
    // jsdom has no canvas backend; the Zzz texture tolerates a null ctx.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  const advance = (mesh, seconds, dt = 0.05) => {
    for (let t = 0; t < seconds; t += dt) mesh.update(dt);
  };
  const find = (mesh, name) => {
    let out = null;
    mesh.group.traverse((o) => {
      if (o.name === name) out = o;
    });
    return out;
  };

  it("level 2 droops the eyes and shows the pulsing Zzz sprite", () => {
    const mesh = createKeeperMesh({ keeper: { id: "dreams" } });
    const eyes = find(mesh, "eyes");
    const zzz = find(mesh, "zzz");
    expect(eyes).toBeTruthy();
    expect(zzz.visible).toBe(false); // rested: no Zzz

    advance(mesh, 0.6); // stay under the first possible blink (>= 2.4 s away)
    expect(eyes.scale.y).toBeGreaterThan(0.9); // rested: wide open

    mesh.setTired("needs_sleep"); // accepts status strings via tiredLevelFor
    advance(mesh, 0.8);
    expect(eyes.scale.y).toBeLessThan(0.62); // droopy lids
    expect(eyes.position.y).toBeLessThan(0); // slid down
    expect(zzz.visible).toBe(true);
    expect(zzz.material.opacity).toBeGreaterThan(0);

    mesh.setTired(0); // rested again: eyes recover, Zzz gone
    advance(mesh, 0.8);
    expect(eyes.scale.y).toBeGreaterThan(0.9);
    expect(zzz.visible).toBe(false);
    mesh.dispose();
  });

  it("level 1 droops less than level 2 (unrested vs needs_sleep)", () => {
    const a = createKeeperMesh({ keeper: { id: "a" } });
    const b = createKeeperMesh({ keeper: { id: "b" } });
    a.setTired(1);
    b.setTired(2);
    advance(a, 0.8);
    advance(b, 0.8);
    const eyesA = find(a, "eyes");
    const eyesB = find(b, "eyes");
    expect(eyesA.scale.y).toBeGreaterThan(eyesB.scale.y);
    expect(find(a, "zzz").visible).toBe(false); // Zzz only at level 2
    a.dispose();
    b.dispose();
  });

  it("setSleeping closes the eyes, shows Zzz, and wakes cleanly", () => {
    const mesh = createKeeperMesh({ keeper: { id: "dreams" } });
    const eyes = find(mesh, "eyes");
    const zzz = find(mesh, "zzz");

    mesh.setSleeping(true);
    advance(mesh, 1.2);
    expect(eyes.scale.y).toBeLessThan(0.15); // shut
    expect(zzz.visible).toBe(true);

    mesh.setSleeping(false);
    advance(mesh, 1.2);
    expect(eyes.scale.y).toBeGreaterThan(0.85); // reopened
    expect(zzz.visible).toBe(false);
    mesh.dispose();
  });

  it("tolerates garbage dt and disposes with the fatigue extras", () => {
    const mesh = createKeeperMesh({ keeper: { id: "dreams" } });
    mesh.setTired(2);
    mesh.setSleeping(true);
    expect(() => {
      mesh.update(Number.NaN);
      mesh.update(-5);
      mesh.update(0.05);
      mesh.dispose();
    }).not.toThrow();
  });
});

describe("render/speech pure helpers", () => {
  it("wraps at the character budget without splitting short words", () => {
    expect(wrapBubbleText("hello there", 22)).toEqual(["hello there"]);
    const lines = wrapBubbleText("the quick brown fox jumps over the lazy dog", 12);
    expect(lines.every((l) => l.length <= 12)).toBe(true);
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain("quick brown");
  });

  it("hard-breaks single overlong words with a hyphen", () => {
    const lines = wrapBubbleText("Supercalifragilistic", 10);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].endsWith("-")).toBe(true);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
  });

  it("caps the line count with an ellipsis", () => {
    const lines = wrapBubbleText("a b c d e f g h i j k l m n o p", 3, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("...")).toBe(true);
  });

  it("handles empty and whitespace input", () => {
    expect(wrapBubbleText("")).toEqual([]);
    expect(wrapBubbleText("   ")).toEqual([]);
    expect(wrapBubbleText(null)).toEqual([]);
  });

  it("popScale starts at 0, overshoots, settles at 1", () => {
    expect(popScale(0)).toBeCloseTo(0, 5);
    expect(popScale(1)).toBeCloseTo(1, 5);
    let peak = 0;
    for (let t = 0; t <= 1; t += 0.01) peak = Math.max(peak, popScale(t));
    expect(peak).toBeGreaterThan(1.02); // the pop
    expect(popScale(2)).toBeCloseTo(1, 5); // clamped past the end
  });

  it("bubbleSeconds grows with text length but is capped", () => {
    expect(bubbleSeconds("", 4.5)).toBe(4.5);
    expect(bubbleSeconds("hi", 4.5)).toBeGreaterThan(4.5);
    expect(bubbleSeconds("x".repeat(500), 4.5)).toBe(7.5); // base + 3 cap
  });
});

describe("render/speech setTint", () => {
  it("tints active bubbles and every bubble shown afterwards", () => {
    const speech = createSpeech();
    const target = new THREE.Object3D();
    const before = speech.show({ text: "hello", target });
    expect(before.material.color.getHex()).toBe(0xffffff);

    speech.setTint(0x99a1c2); // the night district's moonlit paper
    expect(before.material.color.getHex()).toBe(0x99a1c2);

    const after = speech.show({ text: "still night", target });
    expect(after.material.color.getHex()).toBe(0x99a1c2);

    speech.setTint(Number.NaN); // garbage is ignored
    expect(after.material.color.getHex()).toBe(0x99a1c2);
    speech.dispose();
  });
});

describe("render/camera frameLerp", () => {
  it("matches the per-frame factor at 60fps and compounds correctly", () => {
    expect(frameLerp(0.12, 1 / 60)).toBeCloseTo(0.12, 6);
    expect(frameLerp(0.12, 2 / 60)).toBeCloseTo(1 - Math.pow(0.88, 2), 6);
    expect(frameLerp(0.12, 0)).toBe(0);
    expect(frameLerp(0.12, -1)).toBe(0); // never lerps backwards
  });
});
