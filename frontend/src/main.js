// Boot and mode loop: overworld <-> interior <-> dream movie.
// All rules live behind the engine API; this file only orchestrates.
import { createApi, worldIdFrom } from "./api/api.js";
import { buildLayout } from "./sim/plots.js";
import { createWalker, stepAll } from "./sim/walker.js";
import { hashSeed, mulberry32 } from "./sim/rng.js";
import { WorldScene } from "./render/scene.js";
import { GameCamera } from "./render/camera.js";
import { buildIsland } from "./render/island.js";
import { buildHouse, buildVacantSign } from "./render/house.js";
import { KeeperAvatar } from "./render/keeper.js";
import { InteriorScene } from "./render/interior.js";
import { DreamMovie } from "./render/dreammovie.js";
import { Dialog } from "./ui/dialog.js";
import { Hud } from "./ui/hud.js";
import { BubbleLayer } from "./ui/bubbles.js";
import { Minimap } from "./ui/minimap.js";
import { toast } from "./ui/holo.js";

const params = new URLSearchParams(location.search);
const api = createApi({
  baseUrl: params.get("api") || "",
  worldId: params.get("world") || worldIdFrom(localStorage),
});

const canvas = document.getElementById("world");
const world = new WorldScene(canvas);
const gameCamera = new GameCamera(canvas);
const layout = buildLayout();
const island = buildIsland(world.scene, layout);
const bubbles = new BubbleLayer(document.getElementById("bubbles"));
const dreamMovie = new DreamMovie(document.getElementById("dream-movie"));

let mode = "overworld";           // overworld | interior
let interior = null;
let interiorKeeper = null;
let keepers = [];
const occupancy = new Map();      // plotId -> keeper
const avatars = new Map();        // keeperId -> {avatar, walker}
const houseMeshes = new Map();    // plotId -> mesh
const chatterAt = new Map();      // keeperId -> next time

const dialog = new Dialog({
  api, root: document.getElementById("panels"),
  onWorldChanged: refresh,
});

const hud = new Hud({
  root: document.getElementById("hud"), api,
  onWorldChanged: refresh,
  onExitInterior: exitInterior,
  onDreamReport: (report) => dreamMovie.play(report, refresh),
});

const minimap = new Minimap(document.getElementById("minimap"), {
  onJump: (x, z) => { gameCamera.release(); gameCamera.target.set(x, 0, z); },
});

function assignPlots() {
  occupancy.clear();
  const light = layout.plots.filter((p) => p.side === "light");
  const dark = layout.plots.filter((p) => p.side === "dark");
  let li = 0, di = 0;
  for (const keeper of keepers) {
    const plot = keeper.side === "light" ? light[li++] : dark[di++];
    if (plot) occupancy.set(plot.id, keeper);
  }
}

function rebuildWorldObjects() {
  for (const mesh of houseMeshes.values()) island.group.remove(mesh);
  houseMeshes.clear();
  const liveIds = new Set(keepers.map((k) => k.id));
  for (const [id, entry] of avatars) {
    if (!liveIds.has(id)) {
      island.group.remove(entry.avatar.group);
      avatars.delete(id);
    }
  }
  for (const plot of layout.plots) {
    const keeper = occupancy.get(plot.id);
    const mesh = keeper ? buildHouse(plot, keeper.palette) : buildVacantSign(plot);
    mesh.position.y = island.heightAt(plot.x, plot.z) + 0.02;
    houseMeshes.set(plot.id, mesh);
    island.group.add(mesh);
    if (keeper && !avatars.has(keeper.id)) {
      const avatar = new KeeperAvatar(keeper);
      const walker = createWalker(keeper.id, plot.id, keeper.side, layout.network);
      island.group.add(avatar.group);
      avatars.set(keeper.id, { avatar, walker, keeper });
      chatterAt.set(keeper.id, performance.now() + 3000 + Math.random() * 9000);
    } else if (keeper) {
      avatars.get(keeper.id).keeper = keeper;
    }
  }
}

async function refresh() {
  const state = await api.state();
  keepers = state.keepers;
  assignPlots();
  rebuildWorldObjects();
}

function keeperById(id) { return keepers.find((k) => k.id === id); }

async function enterInterior(keeper) {
  interiorKeeper = keeper;
  interior = new InteriorScene(keeper);
  interior.setBooks(await api.books(keeper.id));
  mode = "interior";
  hud.setInterior(true);
  dialog.openKeeper(keeper);
}

function exitInterior() {
  mode = "overworld";
  interior = null;
  interiorKeeper = null;
  hud.setInterior(false);
  dialog.close();
}

// -- picking ------------------------------------------------------------
let downAt = null;
canvas.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", async (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  if (mode === "interior") {
    const hit = gameCamera.pick(e, interior.scene.children, interior.camera);
    if (hit?.kind === "book") {
      const full = await api.book(interiorKeeper.id, hit.slug);
      const { openReader } = await import("./ui/reader.js");
      openReader(full, {
        root: document.getElementById("panels"),
        onDelete: async (book) => {
          await api.deleteBook(interiorKeeper.id, book.slug);
          interior.setBooks(await api.books(interiorKeeper.id));
          toast("the book is gone");
          refresh();
        },
      });
    } else if (hit?.kind === "keeper") {
      dialog.openKeeper(keeperById(hit.keeperId) || interiorKeeper);
    }
    return;
  }
  const hit = gameCamera.pick(e, island.group.children);
  if (!hit) return;
  if (hit.kind === "keeper") {
    const keeper = keeperById(hit.keeperId);
    const entry = avatars.get(hit.keeperId);
    if (entry) gameCamera.follow(entry.avatar.group);
    dialog.openKeeper(keeper);
  } else if (hit.kind === "house") {
    const keeper = occupancy.get(hit.plotId);
    if (keeper) enterInterior(keeper);
  } else if (hit.kind === "monument") {
    dialog.openMonument();
  } else if (hit.kind === "vacant") {
    toast("a free plot: create a keeper to fill it");
  }
});

// interior shelf panning + view toggle
let interiorDrag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (mode === "interior") interiorDrag = [e.clientX, e.clientY];
});
addEventListener("pointermove", (e) => {
  if (mode !== "interior" || !interiorDrag) return;
  interior.pan(e.clientX - interiorDrag[0], e.clientY - interiorDrag[1]);
  interiorDrag = [e.clientX, e.clientY];
});
addEventListener("pointerup", () => (interiorDrag = null));
addEventListener("dblclick", () => {
  if (mode === "interior") interior.setView(interior.view === "room" ? "shelf" : "room");
});

// -- chatter -------------------------------------------------------------
async function chatterTick(now) {
  if (mode !== "overworld") return;
  for (const [keeperId, at] of chatterAt) {
    if (now < at) continue;
    chatterAt.set(keeperId, now + 9000 + mulberry32(hashSeed(keeperId + now))() * 14000);
    const entry = avatars.get(keeperId);
    if (!entry) continue;
    try {
      const { line } = await api.chatter(keeperId);
      bubbles.say(keeperId, line, entry.keeper.side === "dark");
    } catch { /* bubbles are optional */ }
  }
}

// -- main loop -----------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;

  if (mode === "overworld") {
    stepAll([...avatars.values()].map((a) => a.walker), layout.network, dt);
    for (const { avatar, walker } of avatars.values()) {
      avatar.place(walker.pos.x, walker.pos.z, walker.heading || 0,
        island.heightAt(walker.pos.x, walker.pos.z));
      avatar.bob(t + hashSeed(walker.keeperId) % 7, walker.paused <= 0);
    }
    island.waterUpdate(t);
    gameCamera.update(dt);
    world.blendZones(gameCamera.target.z);
    world.render(gameCamera.camera);
    bubbles.update(
      (x, y, z) => gameCamera.project(x, y, z),
      (keeperId) => avatars.get(keeperId)?.walker.pos);
    minimap.draw({
      plots: layout.plots,
      keepersByPlot: (plotId) => occupancy.get(plotId),
      walkers: [...avatars.values()].map((a) => a.walker),
      cameraTarget: gameCamera.target,
    });
    chatterTick(now);
  } else if (interior) {
    interior.tick(t);
    world.renderer.render(interior.scene, interior.camera);
  }
  requestAnimationFrame(frame);
}

refresh().then(() => requestAnimationFrame(frame)).catch((error) => {
  toast("cannot reach the island: " + (error.message || error));
});
