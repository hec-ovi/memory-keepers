// Camera-driven district blend: environment crossfade continuity, the eased
// blend curve, and the district tracker's hysteresis + event throttling.
import { describe, it, expect } from "vitest";
import { ENV, envAt, mixHexColor, easeBlend, createDistrictTracker } from "../src/render/blend.js";

describe("render/blend mixHexColor", () => {
  it("mixes channel-wise and clamps t", () => {
    expect(mixHexColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mixHexColor(0x112233, 0x112233, 0.7)).toBe(0x112233);
    expect(mixHexColor(0x000000, 0xffffff, -3)).toBe(0x000000);
    expect(mixHexColor(0x000000, 0xffffff, 42)).toBe(0xffffff);
  });
});

describe("render/blend envAt", () => {
  it("matches the presets at the endpoints", () => {
    const day = envAt(0);
    const night = envAt(1);
    expect(day.fogColor).toBe(ENV.day.fogColor);
    expect(day.keyIntensity).toBe(ENV.day.keyIntensity);
    expect(day.bloomThreshold).toBe(ENV.day.bloomThreshold);
    expect(night.fogColor).toBe(ENV.night.fogColor);
    expect(night.keyIntensity).toBe(ENV.night.keyIntensity);
    expect(night.starOpacity).toBe(ENV.night.starOpacity);
  });

  it("clamps out-of-range blends", () => {
    expect(envAt(-2)).toEqual(envAt(0));
    expect(envAt(9)).toEqual(envAt(1));
  });

  it("crossfades continuously (no popping between close blend values)", () => {
    let prev = envAt(0);
    for (let n = 0.01; n <= 1.0001; n += 0.01) {
      const e = envAt(n);
      expect(Math.abs(e.fogNear - prev.fogNear)).toBeLessThan(1);
      expect(Math.abs(e.keyIntensity - prev.keyIntensity)).toBeLessThan(0.05);
      expect(Math.abs(e.bloomThreshold - prev.bloomThreshold)).toBeLessThan(0.02);
      for (const [x, y] of [
        [e.keyPos[0], prev.keyPos[0]],
        [e.keyPos[1], prev.keyPos[1]],
        [e.keyPos[2], prev.keyPos[2]],
      ]) {
        expect(Math.abs(x - y)).toBeLessThan(2);
      }
      prev = e;
    }
  });

  it("night keeps the world readable: a real moon key, not blackness", () => {
    const night = envAt(1);
    expect(night.keyIntensity).toBeGreaterThan(1);
    expect(night.hemiIntensity).toBeGreaterThan(0.4);
  });

  it("bubble tint stays under the bloom threshold at every blend", () => {
    // White paper by day; over the quarter the tint dims so a speech bubble
    // never crosses the (lower) night bloom threshold and blooms unreadable.
    expect(envAt(0).bubbleTint).toBe(0xffffff);
    expect(envAt(1).bubbleTint).toBe(ENV.night.bubbleTint);
    const lum = (hex) =>
      (0.299 * ((hex >> 16) & 0xff) + 0.587 * ((hex >> 8) & 0xff) + 0.114 * (hex & 0xff)) / 255;
    for (let n = 0; n <= 1.0001; n += 0.05) {
      const e = envAt(n);
      // Margin of 0.02 covers the bloom pass's luminance smoothing width.
      expect(lum(e.bubbleTint)).toBeLessThan(e.bloomThreshold - 0.02);
    }
  });
});

describe("render/blend easeBlend", () => {
  it("moves toward the target without overshoot and is deterministic", () => {
    let v = 0;
    let prev = 0;
    for (let i = 0; i < 200; i++) {
      v = easeBlend(v, 1, 1 / 60);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(v).toBeGreaterThan(0.95); // converged after ~3.3s
    expect(easeBlend(0.3, 1, 0.016)).toBe(easeBlend(0.3, 1, 0.016));
  });

  it("dt = 0 changes nothing; negative dt never lerps backwards", () => {
    expect(easeBlend(0.4, 1, 0)).toBe(0.4);
    expect(easeBlend(0.4, 1, -5)).toBe(0.4);
  });
});

describe("render/blend createDistrictTracker", () => {
  it("flips when the blend crosses the high/low thresholds", () => {
    const t = createDistrictTracker();
    expect(t.district).toBe("day");
    expect(t.update(0.2, 0.016)).toBeNull();
    expect(t.update(0.9, 0.016)).toBe("night");
    expect(t.district).toBe("night");
  });

  it("hysteresis: mid-band values never flip", () => {
    const t = createDistrictTracker({ low: 0.45, high: 0.55 });
    t.update(1, 0.016); // now night
    for (let i = 0; i < 100; i++) {
      expect(t.update(0.5, 0.016)).toBeNull(); // dead band
      expect(t.update(0.47, 0.016)).toBeNull(); // below high but above low
    }
    expect(t.district).toBe("night");
  });

  it("throttles: rapid crossings emit at most once per minGapS", () => {
    const t = createDistrictTracker({ minGapS: 1.5 });
    const events = [];
    // Flip-flop across the ridge every frame for 2 simulated seconds.
    for (let i = 0; i < 125; i++) {
      const ev = t.update(i % 2 === 0 ? 1 : 0, 0.016);
      if (ev) events.push(ev);
    }
    expect(events.length).toBeLessThanOrEqual(2); // 2s / 1.5s gap
    expect(events[0]).toBe("night");
  });

  it("a flip blocked by the throttle still lands once the gap expires", () => {
    const t = createDistrictTracker({ minGapS: 1 });
    expect(t.update(1, 0.016)).toBe("night");
    expect(t.update(0, 0.016)).toBeNull(); // throttled
    expect(t.update(0, 1.2)).toBe("day"); // gap expired, flip lands
  });
});

// ---------------------------------------------------------------------------
// blendBand: noise-dithered material transition bands (soft texture edges)
// ---------------------------------------------------------------------------
import { blendBand } from "../src/render/blend.js";

describe("render/blend blendBand", () => {
  it("saturates at 0 and 1 outside the band and is monotonic in value", () => {
    expect(blendBand(-10, 0, 1)).toBe(0);
    expect(blendBand(10, 0, 1)).toBe(1);
    for (const dither of [0, 0.25, 0.5, 0.75, 1]) {
      let prev = -1;
      for (let v = -1; v <= 2; v += 0.02) {
        const b = blendBand(v, 0, 1, dither);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1);
        expect(b).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = b;
      }
    }
  });

  it("dither 0.5 reproduces the plain smoothstep band", () => {
    expect(blendBand(0.5, 0, 1, 0.5)).toBeCloseTo(0.5, 9);
    expect(blendBand(0.25, 0, 1, 0.5)).toBeCloseTo(0.25 * 0.25 * (3 - 2 * 0.25), 9);
  });

  it("dither shifts the crossover point (the border wanders)", () => {
    const low = blendBand(0.5, 0, 1, 0);
    const mid = blendBand(0.5, 0, 1, 0.5);
    const high = blendBand(0.5, 0, 1, 1);
    expect(low).toBeGreaterThan(mid); // band shifted down: value further in
    expect(high).toBeLessThan(mid); // band shifted up: value further out
    expect(low).not.toBeCloseTo(high, 2);
  });

  it("is deterministic and works on non-unit bands", () => {
    expect(blendBand(3, 2, 4, 0.3)).toBe(blendBand(3, 2, 4, 0.3));
    expect(blendBand(1.9, 2, 4, 0.5)).toBe(0);
    expect(blendBand(4.1, 2, 4, 0.5)).toBe(1);
  });
});
