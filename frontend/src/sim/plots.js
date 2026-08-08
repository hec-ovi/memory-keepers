// The island layout: an irregular landmass, a plaza with the monument, a
// messy organic path network, 16 light plots south and 8 dark plots north.
// Pure data; the render box draws it, walkers navigate it.
import { hashSeed, mulberry32 } from "./rng.js";

export const LIGHT_PLOTS = 16;
export const DARK_PLOTS = 8;
export const ISLAND_RADIUS = 46;
export const PLAZA = { x: 0, z: 14 };
export const DARK_HEART = { x: 0, z: -26 };

export function islandRadiusAt(angle, seed = 7) {
  const rng = mulberry32(hashSeed("shore" + seed));
  const lobes = [];
  for (let i = 0; i < 5; i++) lobes.push({ p: rng() * Math.PI * 2, a: 0.06 + rng() * 0.09, f: 1 + i });
  let r = 1;
  for (const l of lobes) r += l.a * Math.sin(angle * l.f + l.p);
  return ISLAND_RADIUS * r;
}

export function buildLayout(seed = 7) {
  const rng = mulberry32(hashSeed("plots" + seed));
  const plots = [];
  const ringsLight = [
    { count: 6, radius: 12, center: PLAZA },
    { count: 10, radius: 22, center: PLAZA },
  ];
  let id = 0;
  for (const ring of ringsLight) {
    for (let i = 0; i < ring.count; i++) {
      const angle = (i / ring.count) * Math.PI * 2 + rng() * 0.5;
      const radius = ring.radius * (0.82 + rng() * 0.34);
      plots.push({
        id: `L${id++}`, side: "light",
        x: ring.center.x + Math.cos(angle) * radius,
        z: ring.center.z + Math.sin(angle) * radius * 0.8,
        angle: angle + Math.PI + (rng() - 0.5) * 0.8,
      });
    }
  }
  for (let i = 0; i < DARK_PLOTS; i++) {
    const angle = (i / DARK_PLOTS) * Math.PI * 2 + rng() * 0.6;
    const radius = 11 * (0.75 + rng() * 0.5);
    plots.push({
      id: `D${i}`, side: "dark",
      x: DARK_HEART.x + Math.cos(angle) * radius * 1.35,
      z: DARK_HEART.z + Math.sin(angle) * radius * 0.75,
      angle: angle + Math.PI + (rng() - 0.5) * 0.8,
    });
  }

  // Path network: plaza and dark heart as hubs, a spine between them,
  // each plot's door node linked to its hub through a jittered junction.
  const nodes = { plaza: { ...PLAZA }, darkheart: { ...DARK_HEART } };
  const edges = [];
  const mid = { x: (PLAZA.x + DARK_HEART.x) / 2 + 4, z: (PLAZA.z + DARK_HEART.z) / 2 };
  nodes.crossing = mid;
  edges.push(["plaza", "crossing"], ["crossing", "darkheart"]);
  for (const plot of plots) {
    const hub = plot.side === "light" ? "plaza" : "darkheart";
    const hubPos = nodes[hub];
    const door = { x: plot.x + Math.cos(plot.angle) * 2.2, z: plot.z + Math.sin(plot.angle) * 2.2 };
    const junction = {
      x: (door.x + hubPos.x) / 2 + (rng() - 0.5) * 5,
      z: (door.z + hubPos.z) / 2 + (rng() - 0.5) * 5,
    };
    nodes[`door:${plot.id}`] = door;
    nodes[`j:${plot.id}`] = junction;
    edges.push([`door:${plot.id}`, `j:${plot.id}`], [`j:${plot.id}`, hub]);
  }
  // Neighbor links make the walk meshy instead of star-shaped.
  const lightPlots = plots.filter((p) => p.side === "light");
  for (let i = 0; i < lightPlots.length; i++) {
    const next = lightPlots[(i + 1) % lightPlots.length];
    edges.push([`j:${lightPlots[i].id}`, `j:${next.id}`]);
  }
  return { plots, network: { nodes, edges } };
}

export function neighborsOf(network) {
  const map = {};
  for (const [a, b] of network.edges) {
    (map[a] = map[a] || []).push(b);
    (map[b] = map[b] || []).push(a);
  }
  return map;
}

export function sideOfNode(name, network) {
  const pos = network.nodes[name];
  return pos.z < -6 ? "dark" : "light";
}
