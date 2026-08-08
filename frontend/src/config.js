// Tunables for the whole frontend. sim/, render/ and ui/ read from here; nothing
// writes to it at runtime.

export const config = {
  // The main keeper (the hologram over the plaza well): a virtual keeper id
  // the dialog and the overworld share.
  monumentId: "the-monument",

  // Day/night is spatial (see render/blend.js + sim/world.js nightMaskAt);
  // there is no global clock in the overworld.

  // --- movement (world units / second) ---
  WALK_SPEED: 1.4,
  HOP_HEIGHT: 0.25,
  ARRIVE_RADIUS: 0.3,
  WANDER_PAUSE_S: [1.5, 5], // [min, max] idle time between wander targets

  // --- chatter bubbles ---
  CHATTER_COOLDOWN_S: 20, // per keeper
  CHATTER_GLOBAL_GAP_S: 6, // min gap between any two bubbles
  BUBBLE_SECONDS: 4.5,

  // --- camera rig ---
  camera: {
    fov: 50,
    minDistance: 4,
    maxDistance: 60,
    minPolarAngle: 0.15,
    maxPolarAngle: Math.PI / 2 - 0.08,
    zoomSpeed: 1.0,
    panSpeed: 0.9,
    rotateSpeed: 0.8,
    focusLerp: 0.12, // per-frame lerp factor when focusing a target
    followLerp: 0.25, // per-frame lerp factor when following a moving target
  },

  // --- colors (hex) ---
  colors: {
    skyDay: 0x87b7e8,
    skyNight: 0x131028,
    waterDay: 0x3a7ca5,
    waterNight: 0x1b2340,
    island: 0x7fb069,
    fogNight: 0x2a2145,
    keeperTone: 0x9fdcff,
    keeperBlush: 0xf27ba4,
    unconsciousTint: 0x6d5a8f,
    selectionRing: 0xffd3a6,
    graphNode: 0xb9a7f8,
    graphEdge: 0x5a4a80,
  },

  // --- graph movie ---
  graph: {
    NODE_WAVE_SECONDS: 2.2, // per wave (keepers, books, entities)
    EDGE_DRAW_SECONDS: 1.6,
    ORBIT_SPEED: 0.05, // rad/s auto-orbit
    MAX_LABELS: 24, // only the top-weight nodes get labels
  },

  // --- consolidation polling ---
  CONSOLIDATION_POLL_MS: 2500,

  // --- scene modules: mode key -> module path (relative to src/main.js) ---
  // main.js dynamic-imports these lazily; a missing/broken module falls back to
  // an animated placeholder, so integrators only flip entries here.
  sceneModules: {
    overworld: "./render/scene_overworld.js",
    interior: "./render/scene_interior.js",
    graph: "./render/scene_graph.js",
  },
};
