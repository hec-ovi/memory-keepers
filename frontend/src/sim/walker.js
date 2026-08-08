// Keeper motion: walk the path network only, never cross to the other side,
// keep separation from other walkers. Pure math, no three.js.
import { hashSeed, mulberry32 } from "./rng.js";
import { neighborsOf, sideOfNode } from "./plots.js";

const SPEED = 2.6;
const SEPARATION = 1.6;

export function createWalker(keeperId, plotId, side, network) {
  const rng = mulberry32(hashSeed("walk" + keeperId));
  const home = `door:${plotId}`;
  const pos = { ...network.nodes[home] };
  return { keeperId, side, home, node: home, target: null, pos, rng, paused: 0 };
}

function pickNext(walker, network, neighbors) {
  const options = (neighbors[walker.node] || []).filter((name) => {
    if (name.startsWith("door:") && name !== walker.home) return false;
    return sideOfNode(name, network) === walker.side;
  });
  if (!options.length) return walker.home;
  return options[Math.floor(walker.rng() * options.length)];
}

export function step(walker, others, network, neighbors, dt) {
  if (walker.paused > 0) {
    walker.paused -= dt;
    return;
  }
  if (!walker.target) {
    walker.target = pickNext(walker, network, neighbors);
  }
  const goal = network.nodes[walker.target];
  let dx = goal.x - walker.pos.x;
  let dz = goal.z - walker.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.3) {
    walker.node = walker.target;
    walker.target = null;
    walker.paused = 1 + walker.rng() * 4;
    return;
  }
  dx /= dist; dz /= dist;
  // separation: slide away from close walkers
  for (const other of others) {
    if (other === walker) continue;
    const ox = walker.pos.x - other.pos.x;
    const oz = walker.pos.z - other.pos.z;
    const od = Math.hypot(ox, oz);
    if (od > 0.001 && od < SEPARATION) {
      const push = (SEPARATION - od) / SEPARATION;
      dx += (ox / od) * push * 1.6;
      dz += (oz / od) * push * 1.6;
    }
  }
  const norm = Math.hypot(dx, dz) || 1;
  walker.pos.x += (dx / norm) * SPEED * dt;
  walker.pos.z += (dz / norm) * SPEED * dt;
  walker.heading = Math.atan2(dz, dx);
}

export function stepAll(walkers, network, dt) {
  const neighbors = neighborsOf(network);
  for (const walker of walkers) step(walker, walkers, network, neighbors, dt);
}
