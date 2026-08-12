// Camera-driven day/night environment blend + district tracking. Pure math,
// no three.js, fully unit-tested. Day/night is SPATIAL: the village district
// is always day, the unconscious quarter is always night, and the camera
// position drives a 0..1 blend (world.nightMaskAt at the camera target) that
// crossfades sky, fog, key light, hemisphere, water/cloud tints and bloom.

export const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function mixHexColor(a, b, t) {
  const k = clamp01(t);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

const lerp = (a, b, t) => a + (b - a) * clamp01(t);

// The two environment presets. Night is a deep-blue MOONLIT look, not
// blackness: a strong cool key, readable hemisphere floor, brighter horizon.
export const ENV = {
  day: {
    skyZenith: 0x4f8ad2,
    skyHorizon: 0xc7e0f0,
    fogColor: 0xc7e0f0,
    // Far planes retuned for the bigger island (size 170): the whole
    // landmass stays readable before the haze takes over.
    fogNear: 95,
    fogFar: 300,
    keyColor: 0xffe2b8,
    keyIntensity: 2.1,
    keyPos: [52, 64, 30],
    hemiSky: 0xbfd9ff,
    hemiGround: 0x8f9d76,
    hemiIntensity: 0.75,
    waterTint: 0xffffff,
    cloudTint: 0xffffff,
    bloomThreshold: 1.05,
    bloomStrength: 0.3,
    starOpacity: 0.35,
    auroraOpacity: 0.4,
    bubbleTint: 0xffffff,
  },
  night: {
    skyZenith: 0x111838,
    skyHorizon: 0x474d8a,
    fogColor: 0x343b66,
    fogNear: 80,
    fogFar: 268,
    keyColor: 0xaebdff,
    keyIntensity: 1.3,
    keyPos: [-58, 56, -46],
    hemiSky: 0x53608f,
    hemiGround: 0x333857,
    hemiIntensity: 0.62,
    waterTint: 0xa3b2e0,
    cloudTint: 0x94a1d0,
    bloomThreshold: 0.7,
    bloomStrength: 0.5,
    starOpacity: 1,
    auroraOpacity: 1,
    // Moonlit paper: keeps speech bubbles under the night bloom threshold so
    // they never bloom into an unreadable white blob over the quarter.
    bubbleTint: 0x99a1c2,
  },
};

// Crossfaded environment at blend n (0 = over the village, 1 = over the
// unconscious quarter). Continuous in n; endpoints match the presets.
export function envAt(n) {
  const t = clamp01(n);
  const d = ENV.day;
  const g = ENV.night;
  return {
    skyZenith: mixHexColor(d.skyZenith, g.skyZenith, t),
    skyHorizon: mixHexColor(d.skyHorizon, g.skyHorizon, t),
    fogColor: mixHexColor(d.fogColor, g.fogColor, t),
    fogNear: lerp(d.fogNear, g.fogNear, t),
    fogFar: lerp(d.fogFar, g.fogFar, t),
    keyColor: mixHexColor(d.keyColor, g.keyColor, t),
    keyIntensity: lerp(d.keyIntensity, g.keyIntensity, t),
    keyPos: [
      lerp(d.keyPos[0], g.keyPos[0], t),
      lerp(d.keyPos[1], g.keyPos[1], t),
      lerp(d.keyPos[2], g.keyPos[2], t),
    ],
    hemiSky: mixHexColor(d.hemiSky, g.hemiSky, t),
    hemiGround: mixHexColor(d.hemiGround, g.hemiGround, t),
    hemiIntensity: lerp(d.hemiIntensity, g.hemiIntensity, t),
    waterTint: mixHexColor(d.waterTint, g.waterTint, t),
    cloudTint: mixHexColor(d.cloudTint, g.cloudTint, t),
    bloomThreshold: lerp(d.bloomThreshold, g.bloomThreshold, t),
    bloomStrength: lerp(d.bloomStrength, g.bloomStrength, t),
    starOpacity: lerp(d.starOpacity, g.starOpacity, t),
    auroraOpacity: lerp(d.auroraOpacity, g.auroraOpacity, t),
    bubbleTint: mixHexColor(d.bubbleTint, g.bubbleTint, t),
  };
}

// Noise-dithered transition band: a smoothstep whose band is shifted by a
// per-sample dither value (0..1, e.g. a noise sample), so material borders
// (grass-sand, grass-dirt, district tint) dissolve organically instead of
// tracing a hard line. Monotonic in `value`, output in [0, 1], and dither
// 0.5 reproduces the plain smoothstep. Pure; tested.
export function blendBand(value, edge0, edge1, dither = 0.5, ditherAmp = 0.6) {
  const span = edge1 - edge0;
  const shift = (clamp01(dither) - 0.5) * span * ditherAmp;
  const t = clamp01((value - (edge0 + shift)) / span);
  return t * t * (3 - 2 * t);
}

// Frame-rate independent exponential ease toward a target blend value.
export function easeBlend(current, target, dt, rate = 3.2) {
  const k = 1 - Math.exp(-rate * Math.max(0, dt));
  return current + (target - current) * k;
}

// Tracks which district dominates the camera. Hysteresis (low/high) stops
// flip-flopping on the ridge line; minGapS throttles the "district:changed"
// events so crossing back and forth cannot spam the bus.
export function createDistrictTracker({ initial = "day", low = 0.45, high = 0.55, minGapS = 1.5 } = {}) {
  let district = initial;
  let cooldown = 0;
  return {
    get district() {
      return district;
    },
    // Advance with the current blend value; returns the new district name
    // when the dominant side flips (throttled), else null.
    update(n, dt = 0) {
      cooldown = Math.max(0, cooldown - Math.max(0, dt));
      const next = n >= high ? "night" : n <= low ? "day" : district;
      if (next !== district && cooldown === 0) {
        district = next;
        cooldown = minGapS;
        return district;
      }
      return null;
    },
  };
}
