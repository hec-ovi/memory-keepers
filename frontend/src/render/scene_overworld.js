// The overworld: one landmass, two districts, and SPATIAL day/night. The
// village around the plaza lives in permanent golden day; the unconscious
// quarter across the ridge lives in permanent deep-blue moonlit night
// (readable, never pitch black: moon key + cool hemisphere + warm windows +
// wisps + obelisk glow + localized stars/aurora overhead). Both districts
// are always visible, lit and pickable. The lighting blend follows the
// CAMERA: world.nightMaskAt at the camera target crossfades sky, fog, key
// light (sun <-> moon), hemisphere, water/cloud tints and bloom, so crossing
// the ridge road feels like walking into another world, continuously.
// Everything sits on world.heightAt.
//
// Factory contract (main.js): createOverworldScene(ctx) with
//   ctx = { state, bus, api, config, container, mode, renderer?, camera? }
// Returns { scene, update(dt), dispose(), onResize(w,h), joinKeeper(keeperId) }.
//
// Bus events emitted:  "keeper:selected" {keeperId}, "house:enter" {keeperId},
//                      "district:changed" {district: "day"|"night"} when the
//                      camera's dominant district flips (throttled),
//                      "minimap:update" {keepers, camera} (throttled),
//                      "cinematic:started" {keeperId, name} when a join
//                      cinematic begins, "cinematic:fade" {seconds} when the
//                      fade to black should play, "cinematic:ended" {keeperId}
//                      when controls are restored
// Bus events consumed: "district:travel" -> glide the camera to the other
//                      district's hub,
//                      "keeper:join" {keeperId} -> the join CINEMATIC: hands-off
//                      third-person chase (camera.startChase) while she walks
//                      home over the street graph (world.routeToDoorFrom),
//                      pause + gentle push at the door,
//                      fade, then "house:enter"; a keeper already at home gets
//                      the mini version (pan to her, fade, enter); user input
//                      is locked for the duration and a second "keeper:join"
//                      is ignored,
//                      "cinematic:skip" -> jump straight to the fade + enter,
//                      "minimap:jump" {x, z} -> camera glides there
//                      (ignored while a cinematic plays, as is
//                      "district:travel" and click-picking),
//                      "keeper:selected" {keeperId} -> select-to-follow: the
//                      camera tweens to the standard framing
//                      (camera.FOLLOW_FRAMING) and follows her while she
//                      walks; any user camera input, clicking elsewhere or
//                      the talk panel closing exits the follow,
//                      "ui:close" {panel: "dialog"} -> deselect (selection
//                      ring off, follow ends),
//                      "state:loaded" -> re-apply each keeper's tired level
//                      (mesh.setTired from keeper.session.status),
//                      "keeper:sleep" {keeperId} -> the SLEEP choreography
//                      (ambient, no input lock): she stops chatting, walks
//                      home over the street graph, fades through the door,
//                      the windows dim and a dream effect plays over the
//                      roof until "keeper:rested" {keeperId} fades it out and
//                      she re-emerges rested with a small sparkle,
//                      "memory:used" {keeperId, slugs} -> a brief sparkle +
//                      tiny book sprite above her head (the interior plays
//                      the physical fetch; out here it is just a glint)

import * as THREE from "three";
import { createRenderer } from "./renderer.js";
import { createCameraRig, FOLLOW_FRAMING } from "./camera.js";
import { createKeeperMesh, tiredLevelFor } from "./keeper_mesh.js";
import { createHoloDissolve } from "./holo_dissolve.js";
import { createSpeech, bubbleSeconds } from "./speech.js";
import { buildTerrain, buildWater, buildShoreFoam, buildGrass, extractShoreline } from "./terrain.js";
import { buildSkyDome, buildClouds, buildNightSky } from "./sky.js";
import {
  buildCottage,
  buildStreetRibbon,
  buildPlaza,
  buildProp,
  buildTrees,
  buildEmptyPlots,
  buildGardens,
  cottageObstacles,
  makeCobbleTexture,
  makeSandPathTexture,
} from "./props.js";
import { overworldFlags, createBloomPipeline } from "./fx.js";
import { clamp01, envAt, easeBlend, createDistrictTracker } from "./blend.js";
import {
  layoutWorld,
  makeGraphWanderPlanner,
  clampToSector,
  CAMERA_OVERRIDES,
} from "../sim/world.js";
import { hashString } from "../sim/rand.js";
import { createWalker } from "../sim/walker.js";
import { createChatter } from "../sim/chatter.js";
import { config as defaultConfig } from "../config.js";

const KEEPER_Y = 0.52; // blob center above the ground
const SEPARATION_RADIUS = 0.95; // ~1.6 keeper body radii: how close keepers may stand
const WALK_SPEED_SCALE = 1.5; // the island grew ~2.3x in area; walks keep pace
const SHADOW_EXTENT = 80; // shadow camera half-size fitted to the big island
const EMPTY_SPUR_FADE = 0.55; // spurs to undiscovered plots read fainter
const MINI_JOIN_DISTANCE = 2.4; // already this close to her door: mini cinematic
const SLEEP_DOOR_DISTANCE = 1.4; // already at her door: skip the walk home
const DREAM_HEIGHT = 3.3; // dream effect hangs this far above the cottage base
const WINDOW_GLOW = { day: 0.12, night: 1.45 }; // rebuild constants, reused for dimming
const WINDOW_DIM = { day: 0.02, night: 0.3 }; // dimmed while she dreams
const MEMORY_FX_SECONDS = 1.6; // sparkle + tiny book over her head

// ---------------------------------------------------------------------------
// Join-cinematic timeline (pure; tested without WebGL)
// ---------------------------------------------------------------------------
//
// Phases: idle -> walking -> arrived (pause, then the door push) -> fade ->
// idle again once "enter" fires. The mini variant (keeper already at home)
// runs idle -> pan -> fade. skip() jumps any active phase straight to fade.
// start()/arrive()/skip()/update(dt) each return the list of events the
// caller should act on this tick:
//   "started"  cinematic begins (lock input, letterbox in)
//   "walk"     third-person chase starts (full version)
//   "pan"      camera pans to the keeper (mini version)
//   "arrived"  she reached the door (brief pause begins)
//   "push"     the gentle camera push toward the door begins
//   "fade"     fade to black starts
//   "enter"    fade finished: fire "house:enter" + "cinematic:ended"

export const CINEMATIC_TIMING = {
  pauseS: 0.7, // beat at the door before the push
  pushS: 1.1, // gentle dolly toward the door
  fadeS: 0.5, // fade to black
  panS: 1.5, // mini version: pan onto her before fading
};

export function createCinematicTimeline(timing = {}) {
  const t = { ...CINEMATIC_TIMING, ...timing };
  let phase = "idle";
  let clock = 0;
  let pushed = false;

  const goto = (next) => {
    phase = next;
    clock = 0;
  };

  return {
    get phase() {
      return phase;
    },
    get active() {
      return phase !== "idle";
    },

    // Returns the start events, or null when a cinematic is already playing
    // (a second join is ignored).
    start({ mini = false } = {}) {
      if (phase !== "idle") return null;
      pushed = false;
      goto(mini ? "pan" : "walking");
      return ["started", mini ? "pan" : "walk"];
    },

    // The walker reached the door (only meaningful while walking).
    arrive() {
      if (phase !== "walking") return [];
      goto("arrived");
      return ["arrived"];
    },

    // Skip: jump straight to the fade from any active pre-fade phase.
    skip() {
      if (phase === "idle" || phase === "fade") return [];
      goto("fade");
      return ["fade"];
    },

    // Hard abort (e.g. the scene rebuilt underneath the cinematic): back to
    // idle without firing "enter".
    cancel() {
      goto("idle");
      pushed = false;
    },

    update(dt) {
      if (phase === "idle" || phase === "walking") return [];
      clock += dt;
      const events = [];
      if (phase === "arrived") {
        if (!pushed && clock >= t.pauseS) {
          pushed = true;
          events.push("push");
        }
        if (clock >= t.pauseS + t.pushS) {
          goto("fade");
          events.push("fade");
        }
      } else if (phase === "pan") {
        if (clock >= t.panS) {
          goto("fade");
          events.push("fade");
        }
      } else if (phase === "fade") {
        if (clock >= t.fadeS) {
          goto("idle");
          events.push("enter");
        }
      }
      return events;
    },
  };
}

// ---------------------------------------------------------------------------
// Sleep choreography timeline (pure; tested without WebGL)
// ---------------------------------------------------------------------------
//
// On "keeper:sleep" the keeper walks home over the street graph, slips through
// the door (fades out), the cottage windows dim and a soft dream effect
// plays above the roof until "keeper:rested" wakes her: the effect fades and
// she re-emerges rested with a small sparkle. Ambient, never a cinematic:
// no input lock anywhere. Phases:
//   idle -> walking -> entering -> dreaming -> waking -> idle
// start({atDoor: true}) skips the walk (she is already at her door).
// rested() during walking/entering is remembered, and the dream always
// dwells: "wake" never fires before minDreamS of dreaming, so even a
// backend that finishes instantly shows a visible beat of dreaming over
// the roof. Events returned by start/arrive/rested/update:
//   "started"  the choreography begins (she stops chatting)
//   "walk"     she routes home over the street graph
//   "enter"    at the door: she fades through it, windows dim, dream fx ramp
//   "dream"    she is inside; the dream effect is fully on
//   "wake"     rested: the effect fades, she fades back in at the doorstep
//   "done"     re-emerged; effect removed, back to plain wandering

export const SLEEP_TIMING = {
  enterS: 0.7, // fade through the door (windows dim, dream fx ramps in)
  wakeS: 0.9, // effect fades out while she fades back in
  sparkleS: 1.4, // the re-emerge sparkle's lifetime
  minDreamS: 2.4, // minimum visible dreaming, even when the job is instant
};

export function createSleepTimeline(timing = {}) {
  const t = { ...SLEEP_TIMING, ...timing };
  let phase = "idle";
  let clock = 0;
  let pendingRested = false;

  const goto = (next) => {
    phase = next;
    clock = 0;
  };

  return {
    get phase() {
      return phase;
    },
    get active() {
      return phase !== "idle";
    },
    get clock() {
      return clock;
    },
    get timing() {
      return t;
    },

    // Returns the start events, or null when already running.
    start({ atDoor = false } = {}) {
      if (phase !== "idle") return null;
      pendingRested = false;
      goto(atDoor ? "entering" : "walking");
      return ["started", atDoor ? "enter" : "walk"];
    },

    // The walker reached her door (only meaningful while walking).
    arrive() {
      if (phase !== "walking") return [];
      goto("entering");
      return ["enter"];
    },

    // The sleep job finished. From dreaming past the minimum dwell: wake
    // now. Earlier (walking home, slipping inside, or dreaming for less
    // than minDreamS): remembered, wake fires once the dwell is served.
    rested() {
      if (phase === "dreaming" && clock >= t.minDreamS) {
        goto("waking");
        return ["wake"];
      }
      if (phase === "walking" || phase === "entering" || phase === "dreaming") {
        pendingRested = true;
      }
      return [];
    },

    // Hard abort (scene rebuild): back to idle without firing wake/done.
    cancel() {
      goto("idle");
      pendingRested = false;
    },

    update(dt) {
      if (phase !== "entering" && phase !== "dreaming" && phase !== "waking") return [];
      clock += dt;
      const events = [];
      if (phase === "entering" && clock >= t.enterS) {
        goto("dreaming");
        events.push("dream");
      } else if (phase === "dreaming" && pendingRested && clock >= t.minDreamS) {
        // The job finished early: the dream dwelled its minimum, wake now.
        pendingRested = false;
        goto("waking");
        events.push("wake");
      } else if (phase === "waking" && clock >= t.wakeS) {
        goto("idle");
        events.push("done");
      }
      return events;
    },
  };
}

// Dream-effect intensity for a timeline state: ramps in while she enters,
// full while dreaming, fades while waking. Pure; clamped to [0, 1].
export function sleepGlow(phase, clock, timing = SLEEP_TIMING) {
  if (phase === "entering") return clamp01(clock / Math.max(1e-6, timing.enterS));
  if (phase === "dreaming") return 1;
  if (phase === "waking") return 1 - clamp01(clock / Math.max(1e-6, timing.wakeS));
  return 0;
}

// One dream wisp over its loop, u in [0,1): rises, breathes in and out of
// visibility (opacity 0 at both ends so the loop never pops), grows softly.
export function dreamWisp(u, { rise = 1.3 } = {}) {
  const k = (((Number.isFinite(u) ? u : 0) % 1) + 1) % 1;
  return { y: k * rise, opacity: Math.sin(Math.PI * k) * 0.55, scale: 0.55 + 0.5 * k };
}

// The selection ring's render spec: street ribbons draw at
// renderOrder 1 with polygonOffset -2, so the ring renders AFTER them (order
// 2) and biases deeper (-4): it always reads crisply ON the path, never
// under the street texture, while normal depth testing still hides it
// behind hills.
export const SELECTION_RING = {
  inner: 0.62,
  outer: 0.82,
  lift: 0.06, // ring plane above the terrain
  renderOrder: 2, // streets are 1: the ring blends on top of them
  polygonOffsetFactor: -4, // deeper bias than the ribbons' -2
  polygonOffsetUnits: -4,
};

// Chatter etiquette: while ANY keeper is walking to a house (the
// join cinematic, or a sleep walk home) no chatter bubble spawns anywhere;
// bubbles resume once she arrives. Pure; the scene's chatter driver feeds
// chatter.update an empty visible list while this is true (timers keep
// ticking, nobody speaks).
export function chatterPausedFor({ cinematicActive = false, sleepPhases = [] } = {}) {
  if (cinematicActive) return true;
  for (const phase of sleepPhases) if (phase === "walking") return true;
  return false;
}

// Resolve a raycast hit to its pick target: walk up the parents to the first
// node carrying userData.pick (a door mesh keeps its own pick; any other
// cottage part bubbles up to the group's "house" pick). Hidden
// targets resolve to null: the raycaster does not honor ancestor visibility.
export function resolvePickTarget(obj) {
  let node = obj;
  while (node && !node.userData?.pick) node = node.parent;
  if (!node) return null;
  for (let o = obj; o; o = o.parent) if (o.visible === false) return null;
  return { pick: node.userData.pick, keeperId: node.userData.keeperId ?? null };
}

// What a resolved click means for selection (pure; the scene's pointerup
// feeds it the first resolvePickTarget hit, or null when the ray met
// nothing pickable). Clicking her or her cottage selects; the door enters;
// clicking anywhere else while someone is selected DESELECTS her (ring off,
// follow ends; "keeper:deselected" is emitted but the talk panel stays
// open, only its header X closes it).
export function clickOutcome(target, selectedKeeperId = null) {
  if (target) {
    const { pick, keeperId } = target;
    if (pick === "keeper" || pick === "house") return { type: "select", keeperId };
    if (pick === "door") return { type: "enter", keeperId };
    if (pick === "monument") return { type: "monument" };
    return null; // an unknown pick kind changes nothing
  }
  return selectedKeeperId ? { type: "deselect", keeperId: selectedKeeperId } : null;
}

export function createOverworldScene(ctx = {}) {
  const { state = { keepers: [] }, bus, api } = ctx;
  const config = ctx.config ?? defaultConfig;
  const colors = config.colors;
  const monumentId = config.monumentId ?? "the-monument";

  // Renderer + camera: use injected ones, else own them.
  const ownRenderer = !ctx.renderer;
  const rendererWrap = ctx.renderer ?? createRenderer({ container: ctx.container });
  const ownCamera = !ctx.camera;
  const { width, height } = rendererWrap.size ?? { width: 1, height: 1 };
  // Camera limits: config.camera plus the bigger-island overrides exported
  // by sim/world.js (config.js itself stays untouched).
  const cameraRig =
    ctx.camera ??
    createCameraRig({
      domElement: rendererWrap.domElement,
      config: { ...config.camera, ...CAMERA_OVERRIDES },
      aspect: width / height,
    });
  const camera = cameraRig.camera;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(colors.skyDay);
  scene.fog = new THREE.Fog(colors.skyDay, 95, 300);

  // --- lights: one shadow-casting key (sun <-> moon with the camera blend),
  // hemisphere fill, plus a localized cool moon fill that keeps the night
  // quarter readable even when the camera (and the sun key) sit over the
  // village ---
  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x8f9d76, 0.75);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe0b5, 2.1);
  key.castShadow = true;
  // Bigger island, bigger shadow map: 4096 keeps the texel density of the
  // old 2048 map over the old 46-unit extents.
  key.shadow.mapSize.set(4096, 4096);
  // Shadow camera fitted to the whole landmass (both districts) so shadows
  // stay crisp.
  key.shadow.camera.left = -SHADOW_EXTENT;
  key.shadow.camera.right = SHADOW_EXTENT;
  key.shadow.camera.top = SHADOW_EXTENT;
  key.shadow.camera.bottom = -SHADOW_EXTENT;
  key.shadow.camera.near = 4;
  key.shadow.camera.far = 240;
  key.shadow.camera.updateProjectionMatrix(); // extents changed after construction
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.05; // ~one shadow texel; larger values erode small shadows away
  key.target.position.set(-9, 0, -9);
  scene.add(key);
  scene.add(key.target);
  const moonFill = new THREE.PointLight(0x9db4ff, 14, 68, 0.8);
  scene.add(moonFill);

  // --- optional bloom (render/fx.js flags) ---
  let pipeline = null;
  const wantBloom = overworldFlags.bloom;
  if (wantBloom && ownRenderer && typeof rendererWrap.setPipeline === "function" && rendererWrap.renderer) {
    try {
      pipeline = createBloomPipeline({ renderer: rendererWrap.renderer, scene, camera, width, height });
      rendererWrap.setPipeline(pipeline);
    } catch (err) {
      console.warn("[memory-keepers] bloom unavailable, rendering direct:", err);
      pipeline = null;
    }
  }

  // --- sky dome (crossfaded by the camera blend) ---
  const sky = buildSkyDome({});
  scene.add(sky.mesh);

  // --- selection ring (slope-aligned each frame; SELECTION_RING keeps it
  // rendering crisply ON the street ribbons, never under them) ---
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(SELECTION_RING.inner, SELECTION_RING.outer, 32),
    new THREE.MeshBasicMaterial({
      color: colors.selectionRing,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: SELECTION_RING.polygonOffsetFactor,
      polygonOffsetUnits: SELECTION_RING.polygonOffsetUnits,
    }),
  );
  ring.renderOrder = SELECTION_RING.renderOrder;
  ring.visible = false;
  scene.add(ring);
  const ringNormal = new THREE.Vector3();
  const RING_UP = new THREE.Vector3(0, 0, 1); // RingGeometry's local plane normal

  // --- sim ---
  const chatter = createChatter({
    cooldownS: config.CHATTER_COOLDOWN_S,
    globalGapS: config.CHATTER_GLOBAL_GAP_S,
    bubbleS: config.BUBBLE_SECONDS,
  });
  const speech = createSpeech();

  // --- population (terrain + districts + keepers), rebuilt when keepers change ---
  let world = null;
  let worldGroup = null;
  let water = null;
  let foam = null;
  let grass = null;
  let clouds = null;
  let nightSky = null;
  const population = new Map(); // keeperId -> { keeper, mesh, walker, dark, home }
  let nightGlowMats = []; // night crystals, wisps, obelisk (always aglow, pulsing)
  let floaters = []; // wisps bobbing on the spot
  let mists = []; // empty-plot mist sprites, drifting
  let pickables = [];
  let monumentHolo = null; // the big holographic keeper floating over the well
  let monumentDissolve = null; // her disintegration point shell
  let monumentBaseY = 0;
  let monumentT = 0;
  let populationKey = null;
  let joining = null; // { keeperId } while she walks the graph route home
  const cineTimeline = createCinematicTimeline();
  let cine = null; // { keeperId, entry } while the join cinematic plays
  const sleeping = new Map(); // keeperId -> { entry, timeline, route, dream }
  const transientFx = []; // short-lived sparkles / memory glints
  let cameraPlaced = false; // first build: park the rig over the plaza

  function populationKeyOf() {
    return (state.keepers ?? [])
      .map((a) => `${a.id}:${a.kind}`)
      .sort()
      .join("|");
  }

  function disposeObject(root) {
    root.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    });
    root.removeFromParent();
  }

  // Positions of every other keeper (for separation steering).
  function neighborsOf(keeperId) {
    const out = [];
    for (const [id, entry] of population) {
      if (id !== keeperId) out.push(entry.walker.position);
    }
    return out;
  }

  function rebuildPopulation() {
    for (const entry of population.values()) entry.mesh.dispose();
    population.clear();
    if (worldGroup) disposeObject(worldGroup);
    worldGroup = new THREE.Group();
    scene.add(worldGroup);
    nightGlowMats = [];
    floaters = [];
    mists = [];
    pickables = [];
    monumentDissolve?.dispose();
    monumentDissolve = null;
    monumentHolo?.dispose();
    monumentHolo = null;
    joining = null;
    abortCinematic(); // a mid-cinematic rebuild restores input + letterbox
    abortSleeps(); // sleep fx belong to the old cottages
    clearTransientFx();

    world = layoutWorld(state.keepers ?? []);

    // Terrain (heightfield, vertex colors x macro texture) + water + coast.
    worldGroup.add(buildTerrain({ world }).mesh);
    water = buildWater({ world });
    worldGroup.add(water.mesh);
    const shoreline = extractShoreline(world);
    foam = buildShoreFoam({ world, chains: shoreline });
    worldGroup.add(foam.group);
    grass = buildGrass({ world });
    worldGroup.add(grass.mesh);
    // The instanced forest (groves + singles, 4 species).
    worldGroup.add(buildTrees({ trees: world.trees }).group);

    // Sky: cumulus + shadow blobs over the day side, wisps + stars + aurora
    // + moon + darker overhead pall over the quarter.
    clouds = buildClouds({ world });
    worldGroup.add(clouds.group);
    nightSky = buildNightSky({ world });
    worldGroup.add(nightSky.group);

    // Moon fill hangs over the night hub.
    moonFill.position.set(world.sectors.night.center.x, 24, world.sectors.night.center.z);

    // Plaza + night hub. Both are always lit and alive; the fine cobbles
    // stay HERE only (streets are sandy lanes).
    const cobbles = makeCobbleTexture();
    const plaza = buildPlaza({
      center: world.plaza.center,
      radius: world.plaza.radius,
      world,
      dark: false,
      texture: cobbles,
    });
    worldGroup.add(plaza.group);
    pickables.push(plaza.group); // the well at the center opens the monument
    for (const m of plaza.glowMats) m.emissiveIntensity = 0.3;

    // The Monument herself: a large figure of drifting particles floating
    // over the well; nothing but her dust is ever drawn. The keeper mesh
    // supplies the shape to sample and stays as the invisible hit volume:
    // hidden at the MATERIAL level, because the raycaster ignores material
    // visibility while resolvePickTarget nulls object-level hiding.
    monumentHolo = createKeeperMesh({ keeper: { id: monumentId }, config });
    monumentBaseY = world.heightAt(world.plaza.center.x, world.plaza.center.z) + 3.2;
    const holoGroup = monumentHolo.group;
    holoGroup.scale.setScalar(2.6);
    holoGroup.position.set(world.plaza.center.x, monumentBaseY, world.plaza.center.z);
    holoGroup.traverse((obj) => {
      obj.userData = { ...(obj.userData ?? {}), pick: "monument" };
      if (obj.isMesh) obj.castShadow = false;
      if (obj.name === "visor") obj.visible = false;
    });
    monumentDissolve = createHoloDissolve({
      source: holoGroup, maxPoints: 12000, pointSize: 2.6,
    });
    holoGroup.traverse((obj) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m.visible = false;
    });
    worldGroup.add(holoGroup);
    pickables.push(holoGroup);
    const hub = buildPlaza({
      center: world.hub.center,
      radius: world.hub.radius,
      world,
      dark: true,
      texture: cobbles,
    });
    worldGroup.add(hub.group);
    nightGlowMats.push(...hub.glowMats);

    // Streets: sandy lanes with soft edges. Width comes from the tier
    // (avenues/lane/ridge wide, plot spurs narrow); spurs to empty plots
    // render fainter but are always there (pre-routed network). Ends that
    // meet the plaza, the hub or another lane (the graph's junction hints)
    // fade out aggressively so path endings never draw a collided edge;
    // plot ends (door approaches) stay solid.
    const sand = makeSandPathTexture();
    const plotOccupied = new Map(world.plots.map((p) => [p.id, p.occupied]));
    const FADE_END_KINDS = new Set(["plaza", "hub", "junction"]);
    for (const street of world.streets) {
      const empty = street.kind === "spur" && !plotOccupied.get(street.plotId);
      const ribbon = buildStreetRibbon({
        points: street.points,
        world,
        width: street.width,
        texture: sand,
        fade: empty ? EMPTY_SPUR_FADE : 1,
        endFade: {
          head: FADE_END_KINDS.has(street.ends?.head),
          tail: FADE_END_KINDS.has(street.ends?.tail),
        },
      });
      if (ribbon) worldGroup.add(ribbon);
    }

    // Empty plots: undiscovered sites (stone circle + VACANT signpost +
    // mist), instanced across all of them (6 draw calls + one mist sprite
    // each). Occupied plots get their little garden instead.
    const sites = buildEmptyPlots({ plots: world.plots.filter((p) => !p.occupied) });
    worldGroup.add(sites.group);
    mists.push(...sites.mist);
    const gardens = buildGardens({
      plots: world.plots.filter((p) => p.occupied),
    });
    worldGroup.add(gardens.group);
    nightGlowMats.push(...gardens.glowMats);

    // Walkers dodge the world's solid circles PLUS each cottage's variant
    // extensions (porch pillars, sheds), so entry walks never clip through
    // geometry. One shared array: it grows as cottages build below, and
    // every walker reads it live.
    const walkerObstacles = [...world.obstacles];

    for (const keeper of state.keepers ?? []) {
      const home = world.homes[keeper.id];
      // Beyond plot capacity (world.unplaced): no home yet; she simply is
      // not in the overworld until a plot frees up.
      if (!home) continue;
      const dark = home.sector === "night";
      const sector = world.sectors[home.sector];

      const cottage = buildCottage({ keeper, dark });
      cottage.group.position.set(home.x, home.y, home.z);
      cottage.group.rotation.y = Math.PI / 2 - home.angle;
      worldGroup.add(cottage.group);
      // District lighting is static: day windows stay subtle, the quarter's
      // windows/lanterns burn warm around the clock (it is always night
      // there). Sleep dims the windows toward WINDOW_DIM while she dreams.
      for (const m of cottage.windowMats)
        m.emissiveIntensity = dark ? WINDOW_GLOW.night : WINDOW_GLOW.day;
      for (const m of cottage.lanternMats) m.emissiveIntensity = dark ? 1.6 : 0.15;
      // The whole cottage picks (group userData "house" -> select the owner);
      // the door mesh inside keeps its own "door" pick (enter the interior).
      pickables.push(cottage.group);
      walkerObstacles.push(...cottageObstacles(keeper.id, home));

      const mesh = createKeeperMesh({ keeper, config });
      mesh.setTired(tiredLevelFor(keeper));
      mesh.group.position.set(home.spawn.x, world.heightAt(home.spawn.x, home.spawn.z) + KEEPER_Y, home.spawn.z);
      worldGroup.add(mesh.group);
      mesh.group.traverse((obj) => {
        if (obj.userData?.pick === "keeper") pickables.push(obj);
      });

      // NPCs walk ONLY on the street network: wandering plans routes over
      // the graph (their own garden, the district junctions, the plaza or
      // night hub) and the walker clamps its live position to the route, so
      // separation lets keepers slow down or pass on the shoulder but never
      // shove each other off the path. The sector clamp still guarantees
      // nobody ever crosses districts.
      const walker = createWalker({
        position: home.spawn,
        speed: (dark ? config.WALK_SPEED * 0.45 : config.WALK_SPEED) * WALK_SPEED_SCALE,
        arriveRadius: config.ARRIVE_RADIUS,
        pauseRange: config.WANDER_PAUSE_S,
        sampleRoute: makeGraphWanderPlanner(world, { sector: home.sector, plotId: home.plotId }),
        neighbors: () => neighborsOf(keeper.id),
        obstacles: walkerObstacles,
        separationRadius: SEPARATION_RADIUS,
        separationBias: ((hashString(keeper.id) % 628) / 628) * Math.PI * 2,
        clamp: (p) => clampToSector(sector, p, 0.9),
      });

      population.set(keeper.id, { keeper, mesh, walker, dark, home, cottage });
    }

    // Props per sector; the night quarter's crystals and wisps always glow.
    for (const prop of world.props) {
      const dark = prop.sector === "night";
      const built = buildProp(prop, dark);
      built.group.position.y = prop.y - 0.04; // settle into the ground, never float
      worldGroup.add(built.group);
      if (dark) nightGlowMats.push(...built.glowMats);
      else for (const m of built.glowMats) m.emissiveIntensity = 0.3;
      if (built.floaty) floaters.push({ group: built.group, baseY: prop.y, phase: prop.rotation });
    }

    populationKey = populationKeyOf();

    // First build with an owned rig: park the camera over the plaza so the
    // bigger island opens on the village, not on open water.
    if (!cameraPlaced && ownCamera && cameraRig.controls?.target) {
      cameraPlaced = true;
      const hubC = world.sectors.day.hub;
      const y = world.heightAt(hubC.x, hubC.z);
      cameraRig.controls.target.set(hubC.x, y + 0.5, hubC.z);
      camera.position.set(hubC.x + 14, y + 13, hubC.z + 18);
      cameraRig.controls.update?.();
    }
  }

  rebuildPopulation();

  // --- picking (click = tiny pointer travel, so orbit drags do not select) ---
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = null;
  const dom = rendererWrap.domElement;

  function onPointerDown(e) {
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  function onPointerUp(e) {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const held = performance.now() - downAt.t;
    downAt = null;
    if (cine) return; // cinematic: selection is locked along with the camera
    if (moved > 6 || held > 450) return;

    const rect = dom.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables, true);
    let picked = null;
    for (const hit of hits) {
      picked = resolvePickTarget(hit.object);
      if (picked) break;
    }
    const outcome = clickOutcome(picked, state.selectedKeeperId);
    if (!outcome) return;
    const { type, keeperId } = outcome;
    if (type === "select") {
      // Clicking her, or any part of her cottage, selects her. The
      // "keeper:selected" subscription below applies the select-to-follow
      // framing (so selection from anywhere frames the same way).
      state.selectedKeeperId = keeperId;
      if (bus) bus.emit("keeper:selected", { keeperId });
      else followSelected(keeperId);
    } else if (type === "enter") {
      bus?.emit("house:enter", { keeperId });
    } else if (type === "monument") {
      if (state.selectedKeeperId && state.selectedKeeperId !== monumentId) {
        bus?.emit("keeper:deselected", { keeperId: state.selectedKeeperId });
      }
      state.selectedKeeperId = monumentId;
      if (bus) bus.emit("keeper:selected", { keeperId: monumentId });
      else followSelected(monumentId);
    } else if (type === "deselect") {
      // Clicking elsewhere (empty ground, a tree, the sea) deselects:
      // "keeper:deselected" is emitted (the talk panel stays open; only its
      // header X closes it), then deselect() ends the ring and the follow.
      bus?.emit("keeper:deselected", { keeperId });
      deselect();
    }
  }

  dom.addEventListener("pointerdown", onPointerDown);
  dom.addEventListener("pointerup", onPointerUp);

  // --- select-to-follow -----------------------------------------
  // Selecting a keeper (click on her, on her cottage, or any module emitting
  // "keeper:selected") tweens the camera to the standard framing and FOLLOWS
  // her while she walks. The rig already cancels follow on any user camera
  // input (pan/orbit/zoom) and clicking elsewhere reaches OrbitControls too,
  // so those exits come for free; closing the talk panel deselects below.
  let pendingDeselect = false; // ui:close seen; resolved next frame

  function followSelected(keeperId) {
    pendingDeselect = false; // a fresh selection outlives any panel churn
    if (cine) return; // the join cinematic owns the camera
    const entry = population.get(keeperId);
    if (!entry) {
      if (keeperId === monumentId && monumentHolo) {
        cameraRig.follow(monumentHolo.group, { framing: FOLLOW_FRAMING });
      }
      return;
    }
    cameraRig.follow(entry.mesh.group, { framing: FOLLOW_FRAMING });
  }

  function deselect() {
    pendingDeselect = false;
    state.selectedKeeperId = null;
    cameraRig.stopFollow?.();
  }

  // --- join cinematic: hands-off third-person walk home ---------------------
  // Act on the pure timeline's events (see createCinematicTimeline).
  function handleCinematicEvents(events) {
    if (!cine || !events) return;
    for (const ev of events) {
      if (ev === "push") {
        // The gentle dolly toward the door: tighter, lower frame; the chase
        // solver damps into it (no-op for the mini version, which pans).
        cameraRig.setChaseParams?.({ distance: 3.0, height: 1.45, lookAhead: 0.8, posLerp: 0.04, lookLerp: 0.08 });
      } else if (ev === "fade") {
        joining = null;
        cine.entry.walker.stop();
        bus?.emit("cinematic:fade", { seconds: CINEMATIC_TIMING.fadeS });
      } else if (ev === "enter") {
        const keeperId = cine.keeperId;
        endCinematic();
        bus?.emit("house:enter", { keeperId });
      }
    }
  }

  // Restore controls + letterbox; fires "cinematic:ended".
  function endCinematic() {
    if (!cine) return;
    const keeperId = cine.keeperId;
    cine = null;
    joining = null;
    cameraRig.stopChase?.();
    cameraRig.setControlsEnabled?.(true);
    bus?.emit("cinematic:ended", { keeperId });
  }

  function abortCinematic() {
    if (!cine) return;
    cineTimeline.cancel();
    endCinematic();
  }

  function joinKeeper(keeperId) {
    const entry = population.get(keeperId);
    if (!entry) return false;

    // Joining a sleeping keeper: drop the ambient sleep visuals (she is about
    // to be visited anyway); she is at her doorstep, so the mini cinematic
    // takes over naturally.
    const asleep = sleeping.get(keeperId);
    if (asleep) {
      asleep.timeline.cancel();
      removeDream(asleep);
      updateWindows(asleep, 0);
      entry.mesh.setOpacity(1);
      sleeping.delete(keeperId);
    }

    const pos = entry.walker.position;
    const door = entry.home.door;
    // The join walk routes home over the same street graph the wanderers
    // use: nearest node -> her plot's gate -> the doorstep.
    const route = world.routeToDoorFrom(pos, entry.home.plotId);
    // Already at (or next to) her door, or no route: the mini cinematic
    // (pan onto her, fade, enter) instead of the walk.
    const mini = !route.length || Math.hypot(pos.x - door.x, pos.z - door.z) <= MINI_JOIN_DISTANCE;

    const events = cineTimeline.start({ mini });
    if (!events) return false; // a cinematic is already playing: ignored

    cine = { keeperId, entry };
    entry.walker.stop();
    cameraRig.setControlsEnabled?.(false); // input locked: no orbit/pan/zoom
    bus?.emit("cinematic:started", { keeperId, name: entry.keeper.name || keeperId });

    if (mini) {
      cameraRig.focus(entry.mesh.group); // pan onto her; the timeline fades
    } else {
      joining = { keeperId };
      entry.walker.followRoute(route, { goal: true });
      if (typeof cameraRig.startChase === "function") {
        // Low over-the-shoulder chase behind her heading; the walker's live
        // heading keeps pointing at the door once she arrives, so the push
        // glides toward the doorstep. heightAt keeps the camera out of the
        // terrain.
        cameraRig.startChase(entry.mesh.group, {
          heading: () => entry.walker.heading,
          heightAt: (x, z) => world.heightAt(x, z),
        });
      } else if (typeof cameraRig.follow === "function") {
        cameraRig.follow(entry.mesh.group);
      } else {
        cameraRig.focus(entry.mesh.group);
      }
    }
    return true;
  }

  // --- sleep choreography + memory glints (ambient; NO input lock) ----------

  // Small guarded canvas sprite textures (procedural only; undrawn but still
  // disposable when there is no 2d context, e.g. under jsdom).
  function makeFxTexture(draw) {
    if (typeof document === "undefined") return new THREE.Texture();
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    const c = canvas.getContext?.("2d");
    if (c) {
      draw(c, 64);
      tex.needsUpdate = true;
    }
    return tex;
  }

  const drawSoftGlow = (c, s) => {
    const g = c.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(216,196,255,0.9)");
    g.addColorStop(0.55, "rgba(186,166,240,0.35)");
    g.addColorStop(1, "rgba(186,166,240,0)"); // always ends transparent: no rim
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  };

  const drawStar = (c, s) => {
    c.strokeStyle = "rgba(255,240,200,0.95)";
    c.lineWidth = s * 0.08;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(s / 2, s * 0.08);
    c.lineTo(s / 2, s * 0.92);
    c.moveTo(s * 0.08, s / 2);
    c.lineTo(s * 0.92, s / 2);
    c.stroke();
    const g = c.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,246,220,0.9)");
    g.addColorStop(1, "rgba(255,246,220,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  };

  const drawTinyBook = (c, s) => {
    c.fillStyle = "#f6ecdf"; // pages
    c.fillRect(s * 0.2, s * 0.3, s * 0.62, s * 0.42);
    c.fillStyle = "#c9737f"; // cover + spine
    c.fillRect(s * 0.14, s * 0.26, s * 0.13, s * 0.5);
    c.fillStyle = "rgba(90,60,80,0.55)"; // page lines
    for (let i = 0; i < 3; i++) c.fillRect(s * 0.36, s * (0.38 + i * 0.1), s * 0.38, s * 0.03);
  };

  function fxSprite(draw, size, peak = 0.9) {
    const tex = makeFxTexture(draw);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(size, size, 1);
    return { sprite, mat, tex, peak };
  }

  // Short-lived fx: a sprite group that rises and fades (in and out) over
  // ttl seconds, parented anywhere (a keeper's group, the worldGroup).
  function spawnTransientFx({ parent, position, parts, ttl, rise = 0.35 }) {
    const group = new THREE.Group();
    group.position.set(position.x, position.y, position.z);
    for (const part of parts) group.add(part.sprite);
    parent.add(group);
    transientFx.push({ group, parts, t: 0, ttl, rise, baseY: position.y });
  }

  function disposeFx(fx) {
    fx.group.removeFromParent();
    for (const part of fx.parts) {
      part.mat.dispose();
      part.tex.dispose();
    }
  }

  function clearTransientFx() {
    for (const fx of transientFx) disposeFx(fx);
    transientFx.length = 0;
  }

  function updateTransientFx(dt) {
    for (let i = transientFx.length - 1; i >= 0; i--) {
      const fx = transientFx[i];
      fx.t += dt;
      const u = Math.min(1, fx.t / fx.ttl);
      fx.group.position.y = fx.baseY + fx.rise * u;
      const fade = Math.sin(Math.PI * u); // fade in and out, never a pop
      for (const part of fx.parts) part.mat.opacity = part.peak * fade;
      if (u >= 1) {
        disposeFx(fx);
        transientFx.splice(i, 1);
      }
    }
  }

  // "memory:used": a brief glint over her head, a tiny book plus sparkles
  // (the interior plays the physical fetch; out here it is just a glimmer).
  function memoryGlint(keeperId) {
    const entry = population.get(keeperId);
    if (!entry || !entry.mesh.group.visible) return;
    const book = fxSprite(drawTinyBook, 0.34, 0.95);
    const parts = [book];
    for (const [dx, dz, size] of [
      [-0.26, 0.06, 0.16],
      [0.24, -0.04, 0.13],
      [0.05, 0.2, 0.11],
    ]) {
      const star = fxSprite(drawStar, size, 0.8);
      star.sprite.position.set(dx, 0.12 + Math.abs(dx) * 0.4, dz);
      parts.push(star);
    }
    spawnTransientFx({
      parent: entry.mesh.group,
      position: { x: 0, y: 1.25, z: 0 },
      parts,
      ttl: MEMORY_FX_SECONDS,
      rise: 0.3,
    });
  }

  // The re-emerge sparkle at her doorstep when she wakes rested.
  function wakeSparkle(entry) {
    const parts = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const star = fxSprite(drawStar, 0.16 + (i % 2) * 0.08, 0.9);
      star.sprite.position.set(Math.cos(a) * 0.35, (i % 3) * 0.16, Math.sin(a) * 0.35);
      parts.push(star);
    }
    const door = entry.home.door;
    spawnTransientFx({
      parent: worldGroup,
      position: { x: door.x, y: world.heightAt(door.x, door.z) + 0.9, z: door.z },
      parts,
      ttl: SLEEP_TIMING.sparkleS,
      rise: 0.5,
    });
  }

  // The dream over the roof: a slow pulsing glow plus a few wisps rising
  // above the cottage. Subtle and cute: small sprites, low opacity, no light.
  function buildDream(entry) {
    const group = new THREE.Group();
    const home = entry.home;
    group.position.set(home.x, home.y + DREAM_HEIGHT, home.z);
    const glow = fxSprite(drawSoftGlow, 1.9, 0.42);
    group.add(glow.sprite);
    const wisps = [];
    for (let i = 0; i < 3; i++) {
      const wisp = fxSprite(drawSoftGlow, 0.55 - i * 0.08, 0.5);
      wisp.sprite.position.set((i - 1) * 0.35, 0, (i % 2) * 0.2 - 0.1);
      wisps.push({ ...wisp, phase: i / 3, size: 0.55 - i * 0.08 });
      group.add(wisp.sprite);
    }
    worldGroup.add(group);
    return { group, glow, wisps };
  }

  function removeDream(rec) {
    if (!rec.dream) return;
    rec.dream.group.removeFromParent();
    rec.dream.glow.mat.dispose();
    rec.dream.glow.tex.dispose();
    for (const w of rec.dream.wisps) {
      w.mat.dispose();
      w.tex.dispose();
    }
    rec.dream = null;
  }

  // k in [0,1] (sleepGlow): ramps in while she enters, fades while waking.
  function updateDream(rec, k) {
    if (!rec.dream) return;
    rec.dream.glow.mat.opacity = k * (0.3 + 0.12 * Math.sin(elapsed * 1.1));
    for (const w of rec.dream.wisps) {
      const m = dreamWisp(elapsed * 0.22 + w.phase);
      w.sprite.position.y = m.y;
      w.mat.opacity = m.opacity * k;
      w.sprite.scale.set(w.size * m.scale, w.size * m.scale, 1);
    }
  }

  function updateWindows(rec, k) {
    const base = rec.entry.dark ? WINDOW_GLOW.night : WINDOW_GLOW.day;
    const dim = rec.entry.dark ? WINDOW_DIM.night : WINDOW_DIM.day;
    for (const m of rec.entry.cottage.windowMats) m.emissiveIntensity = base + (dim - base) * k;
  }

  // Act on the pure sleep timeline's events (see createSleepTimeline).
  function handleSleepEvents(rec, events) {
    if (!events) return;
    for (const ev of events) {
      if (ev === "walk") {
        rec.entry.walker.followRoute(rec.route, { goal: true });
      } else if (ev === "enter") {
        rec.entry.walker.stop();
        if (!rec.dream) rec.dream = buildDream(rec.entry);
      } else if (ev === "dream") {
        rec.entry.mesh.setOpacity(0); // she is inside now
      } else if (ev === "wake") {
        rec.entry.mesh.setTired(0); // she comes back rested
        wakeSparkle(rec.entry);
      } else if (ev === "done") {
        rec.entry.mesh.setOpacity(1);
        updateWindows(rec, 0);
        removeDream(rec);
        sleeping.delete(rec.keeperId);
      }
    }
  }

  function startSleep(keeperId) {
    const entry = population.get(keeperId);
    if (!entry || sleeping.has(keeperId)) return false;
    if (cine && cine.keeperId === keeperId) return false; // the join cinematic owns her
    const pos = entry.walker.position;
    const door = entry.home.door;
    const route = world.routeToDoorFrom(pos, entry.home.plotId);
    const atDoor =
      !route.length || Math.hypot(pos.x - door.x, pos.z - door.z) <= SLEEP_DOOR_DISTANCE;
    const timeline = createSleepTimeline();
    const events = timeline.start({ atDoor });
    if (!events) return false;
    const rec = { keeperId, entry, timeline, route, dream: null };
    sleeping.set(keeperId, rec);
    entry.walker.stop(); // drop the current wander before the walk home
    handleSleepEvents(rec, events);
    return true;
  }

  function restKeeper(keeperId) {
    const rec = sleeping.get(keeperId);
    if (!rec) return;
    handleSleepEvents(rec, rec.timeline.rested());
  }

  function abortSleeps() {
    for (const rec of sleeping.values()) {
      rec.timeline.cancel();
      removeDream(rec);
      updateWindows(rec, 0);
      rec.entry.mesh.setOpacity(1);
    }
    sleeping.clear();
  }

  // Level/status visuals follow shared state: on every refresh re-read each
  // keeper's session status (rested | unrested | needs_sleep) into setTired.
  function applyTiredLevels() {
    for (const [id, entry] of population) {
      const fresh = (state.keepers ?? []).find((a) => a.id === id);
      if (fresh) entry.keeper = fresh;
      if (!sleeping.has(id)) entry.mesh.setTired(tiredLevelFor(entry.keeper));
    }
  }

  // --- the camera-driven district blend -------------------------------------
  const tracker = createDistrictTracker({ initial: "day" });
  let shownBlend = 0; // eased 0..1 (0 = village, 1 = quarter)
  let announcedDistrict = false;
  const camTargetFallback = new THREE.Vector3();

  function cameraGroundPoint() {
    const t = cameraRig.controls?.target;
    if (t && Number.isFinite(t.x) && Number.isFinite(t.z)) return t;
    return camTargetFallback.copy(camera.position);
  }

  function travelToOtherDistrict() {
    if (cine) return; // cinematic: camera moves are locked
    const goNight = tracker.district !== "night";
    const hub = goNight ? world.sectors.night.hub : world.sectors.day.hub;
    cameraRig.focus({ x: hub.x, y: world.heightAt(hub.x, hub.z) + 0.5, z: hub.z });
  }

  // --- bus wiring (travel button, dialog join button, skip, minimap,
  //     session fatigue + sleep + memory glints) ---
  const unsubs = [];
  if (bus) {
    unsubs.push(bus.on("district:travel", () => travelToOtherDistrict()));
    unsubs.push(bus.on("keeper:join", (p) => joinKeeper(typeof p === "string" ? p : p?.keeperId)));
    // Any selection (scene pick, holo lists, the interior) frames + follows.
    unsubs.push(bus.on("keeper:selected", (p) => followSelected(typeof p === "string" ? p : p?.keeperId)));
    // Closing the talk panel is a deselect: ring off, follow ends. Deferred
    // one frame: switching keepers closes and reopens the panel in the same
    // synchronous chain, and that churn must not kill the fresh selection.
    unsubs.push(
      bus.on("ui:close", (p) => {
        if (p?.panel === "dialog") pendingDeselect = true;
      }),
    );
    unsubs.push(
      bus.on("ui:open", (p) => {
        if (p?.panel === "dialog") pendingDeselect = false;
      }),
    );
    unsubs.push(bus.on("cinematic:skip", () => handleCinematicEvents(cineTimeline.skip())));
    unsubs.push(bus.on("state:loaded", () => applyTiredLevels()));
    unsubs.push(bus.on("keeper:sleep", (p) => startSleep(typeof p === "string" ? p : p?.keeperId)));
    unsubs.push(bus.on("keeper:rested", (p) => restKeeper(typeof p === "string" ? p : p?.keeperId)));
    unsubs.push(bus.on("memory:used", (p) => memoryGlint(p?.keeperId)));
    unsubs.push(
      bus.on("minimap:jump", (p) => {
        if (cine) return; // cinematic: camera moves are locked
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
        cameraRig.focus({ x: p.x, y: world.heightAt(p.x, p.z), z: p.z });
      }),
    );
  }
  const offResize = rendererWrap.onResize?.((w, h) => cameraRig.onResize(w, h));

  // A selection can predate this scene: stepping out of an interior through
  // the keepers list emits "mode:set" then "keeper:selected" while the overworld
  // module is still loading, so the subscription above never hears it.
  // main.js records every selection in state.selectedKeeperId; apply the same
  // follow framing to it on build so selection from anywhere frames alike.
  if (state.selectedKeeperId && population.has(state.selectedKeeperId)) {
    followSelected(state.selectedKeeperId);
  }

  // --- minimap feed (throttled) ---
  const MINIMAP_EVERY_S = 0.25;
  let minimapTimer = 0;
  const camDir = new THREE.Vector3();

  function emitMinimapUpdate() {
    const keepers = [];
    for (const [id, entry] of population) {
      keepers.push({ id, x: entry.walker.position.x, z: entry.walker.position.z });
    }
    camera.getWorldDirection(camDir);
    bus.emit("minimap:update", {
      keepers,
      camera: { x: camera.position.x, z: camera.position.z, angle: Math.atan2(camDir.x, camDir.z) },
    });
  }

  // --- chatter -> api -> speech (works in both districts) ---
  let disposed = false;
  const frustum = new THREE.Frustum();
  const projMat = new THREE.Matrix4();
  const worldPos = new THREE.Vector3();

  function visibleKeeperIds() {
    projMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projMat);
    const ids = [];
    for (const [id, entry] of population) {
      if (sleeping.has(id)) continue; // asleep or walking home: she stops chatting
      if (!entry.mesh.group.visible) continue;
      entry.mesh.group.getWorldPosition(worldPos);
      if (frustum.containsPoint(worldPos)) ids.push(id);
    }
    return ids;
  }

  function speak(keeperId) {
    api
      ?.getChatter(keeperId)
      .then((res) => {
        if (disposed || !res?.line) return;
        const entry = population.get(keeperId);
        if (!entry || !entry.mesh.group.visible) return;
        const seconds = bubbleSeconds(res.line, config.BUBBLE_SECONDS);
        speech.show({ text: res.line, target: entry.mesh.group, offsetY: 0.95, seconds });
        chatter.extendBubble(seconds);
      })
      .catch(() => {}); // ambient flavor; failures stay silent
  }

  // --- environment crossfade (blend.js owns the values) ---
  function applyEnv(n, dt) {
    const env = envAt(n);
    scene.fog.color.set(env.fogColor);
    scene.fog.near = env.fogNear;
    scene.fog.far = env.fogFar;
    scene.background.copy(scene.fog.color);

    hemi.color.set(env.hemiSky);
    hemi.groundColor.set(env.hemiGround);
    hemi.intensity = env.hemiIntensity;
    key.color.set(env.keyColor);
    key.intensity = env.keyIntensity;
    key.position.set(env.keyPos[0], env.keyPos[1], env.keyPos[2]);

    sky.update(n);
    water.update(elapsed, env.waterTint);
    grass.update(elapsed);
    clouds.update(dt, { tint: env.cloudTint, camPos: camera.position });
    nightSky.update(dt, n, elapsed);
    foam.update(elapsed, env.waterTint);
    pipeline?.setEnv?.({ bloomThreshold: env.bloomThreshold, bloomStrength: env.bloomStrength });
    // Bubbles follow the blend too: moonlit paper over the quarter keeps
    // them under the night bloom threshold (readable, not a glowing blob).
    speech.setTint(env.bubbleTint);

    // The quarter's glow (obelisk, crystals, wisps) breathes gently.
    const pulse = 1.15 + 0.25 * Math.sin(elapsed * 1.6);
    for (const m of nightGlowMats) m.emissiveIntensity = pulse;
  }

  // --- main loop ---
  let elapsed = 0;

  function update(dt) {
    if (monumentHolo) {
      monumentT += dt;
      monumentDissolve?.update(dt);
      const g = monumentHolo.group;
      g.position.y = monumentBaseY + Math.sin(monumentT * 0.8) * 0.2;
      // She faces whoever is looking: yaw eased toward the camera each frame.
      const target = Math.atan2(
        camera.position.x - g.position.x,
        camera.position.z - g.position.z,
      );
      let turn = target - g.rotation.y;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      g.rotation.y += turn * Math.min(1, dt * 3.5);
    }
    elapsed += dt;

    // Population changed (create/delete keeper, seed)? Rebuild.
    if (populationKeyOf() !== populationKey) rebuildPopulation();

    // The talk panel closed (and did not reopen within the chain): deselect.
    if (pendingDeselect) deselect();

    // Camera-driven district blend: sample the night mask at the camera
    // target and ease toward it (smooth even when the camera teleports).
    const ground = cameraGroundPoint();
    shownBlend = easeBlend(shownBlend, world.nightMaskAt(ground.x, ground.z), dt);
    applyEnv(shownBlend, dt);

    const flipped = tracker.update(shownBlend, dt);
    if (flipped) {
      announcedDistrict = true;
      bus?.emit("district:changed", { district: flipped });
    } else if (!announcedDistrict && bus) {
      announcedDistrict = true;
      bus.emit("district:changed", { district: tracker.district });
    }

    // Keepers: steering (wander/join + separation + obstacles) + terrain-
    // following animation.
    for (const [id, entry] of population) {
      const { mesh, walker } = entry;
      const events = walker.update(dt);
      if (joining && joining.keeperId === id) {
        for (const ev of events) {
          if (ev.type === "arrive" && ev.goal) {
            joining = null;
            handleCinematicEvents(cineTimeline.arrive()); // door reached: pause + push
          }
        }
      } else if (cine && cine.keeperId === id) {
        // Door pause / mini pan / fade: hold her in place (re-stopping every
        // frame keeps the wander pause from expiring mid-cinematic).
        entry.walker.stop();
      }
      const sleepRec = sleeping.get(id);
      if (sleepRec) {
        if (sleepRec.timeline.phase === "walking") {
          for (const ev of events) {
            if (ev.type === "arrive" && ev.goal) {
              handleSleepEvents(sleepRec, sleepRec.timeline.arrive()); // her door
            }
          }
        } else {
          entry.walker.stop(); // hold at the doorstep while inside / waking
        }
      }
      mesh.setWalking(walker.walking);
      mesh.setSelected(id === state.selectedKeeperId);
      const p = walker.position;
      mesh.group.position.set(p.x, world.heightAt(p.x, p.z) + KEEPER_Y, p.z);
      if (walker.walking) {
        const targetRot = Math.atan2(walker.heading.x, walker.heading.z);
        let d = targetRot - mesh.group.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        mesh.group.rotation.y += d * Math.min(1, dt * 8);
      }
      mesh.update(dt);
    }

    // Wisps bob on the spot.
    for (const f of floaters) {
      f.group.position.y = f.baseY + Math.sin(elapsed * 1.4 + f.phase) * 0.12;
    }

    // Empty-plot mist drifts slowly (undiscovered, faintly alive).
    for (const m of mists) {
      m.sprite.position.y = m.baseY + Math.sin(elapsed * 0.7 + m.phase) * 0.12;
      m.sprite.material.rotation = elapsed * 0.05 + m.phase;
    }

    // Sleep choreography: timeline clocks, the door fade (in AND out: the
    // sleepGlow k runs 0->1 entering and 1->0 waking, so opacity = 1 - k
    // covers both directions), dream fx pulse, window dimming.
    for (const rec of sleeping.values()) {
      const tl = rec.timeline;
      handleSleepEvents(rec, tl.update(dt));
      if (!sleeping.has(rec.keeperId)) continue; // "done" just cleaned it up
      const k = sleepGlow(tl.phase, tl.clock, tl.timing);
      if (tl.phase === "entering" || tl.phase === "waking") rec.entry.mesh.setOpacity(1 - k);
      updateDream(rec, k);
      updateWindows(rec, k);
    }

    // Sparkles and memory glints rise and fade out.
    updateTransientFx(dt);

    // Selection ring: glued to the terrain, aligned to the slope.
    const sel = state.selectedKeeperId ? population.get(state.selectedKeeperId) : null;
    if (sel && sel.mesh.group.visible) {
      const p = sel.walker.position;
      ring.visible = true;
      ring.position.set(p.x, world.heightAt(p.x, p.z) + SELECTION_RING.lift, p.z);
      const nrm = world.normalAt(p.x, p.z);
      ringNormal.set(nrm.x, nrm.y, nrm.z);
      ring.quaternion.setFromUnitVectors(RING_UP, ringNormal);
      const pulse = 1 + 0.06 * Math.sin(elapsed * 4);
      ring.scale.set(pulse, pulse, 1);
    } else {
      ring.visible = false;
    }

    // Chatter. While anyone is walking to a house (join cinematic or a sleep
    // walk home) nobody speaks anywhere: the driver feeds an
    // empty visible list so the timers keep ticking without a pick.
    const paused = chatterPausedFor({
      cinematicActive: Boolean(cine),
      sleepPhases: [...sleeping.values()].map((rec) => rec.timeline.phase),
    });
    const pick = chatter.update(dt, paused ? [] : visibleKeeperIds());
    if (pick) speak(pick.keeperId);
    speech.update(dt);

    // Join-cinematic timeline: door pause -> push -> fade -> enter.
    if (cine) {
      handleCinematicEvents(cineTimeline.update(dt));
      // "enter" fires "house:enter": main.js switches modes and disposes
      // this scene synchronously; nothing below may touch it anymore.
      if (disposed) return;
    }

    cameraRig.update(dt);

    // Minimap feed.
    if (bus) {
      minimapTimer += dt;
      if (minimapTimer >= MINIMAP_EVERY_S) {
        minimapTimer = 0;
        emitMinimapUpdate();
      }
    }

    rendererWrap.render(scene, camera);
  }

  function onResize(w, h) {
    cameraRig.onResize(w, h);
  }

  function dispose() {
    disposed = true;
    abortCinematic(); // never leave input locked or the letterbox up
    abortSleeps();
    clearTransientFx();
    dom.removeEventListener("pointerdown", onPointerDown);
    dom.removeEventListener("pointerup", onPointerUp);
    for (const off of unsubs) off();
    offResize?.();
    speech.dispose();
    for (const entry of population.values()) entry.mesh.dispose();
    population.clear();
    if (pipeline) {
      rendererWrap.setPipeline?.(null);
      pipeline.dispose();
      pipeline = null;
    }
    scene.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    });
    if (ownCamera) cameraRig.dispose();
    if (ownRenderer) rendererWrap.dispose();
  }

  return { scene, update, dispose, onResize, joinKeeper };
}

export default createOverworldScene;
