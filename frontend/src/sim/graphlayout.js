// Deterministic force layout for the dream graph: seeded start, fixed
// iteration count, same input gives the same picture every time.
import { hashSeed, mulberry32 } from "./rng.js";

export function layout(graph, iterations = 160) {
  const nodes = graph.nodes.map((n) => {
    const rng = mulberry32(hashSeed(n.id));
    return { ...n, x: rng() * 2 - 1, y: rng() * 2 - 1, vx: 0, vy: 0 };
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const springs = graph.edges
    .filter((e) => byId[e.source] && byId[e.target])
    .map((e) => ({ a: byId[e.source], b: byId[e.target], w: e.weight || 1 }));

  for (let it = 0; it < iterations; it++) {
    const heat = 0.05 * (1 - it / iterations);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 0.01;
        const force = 0.012 / d2;
        dx *= force; dy *= force;
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
      }
    }
    for (const { a, b, w } of springs) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const pull = 0.02 * Math.min(w, 3);
      a.vx += dx * pull; a.vy += dy * pull;
      b.vx -= dx * pull; b.vy -= dy * pull;
    }
    for (const n of nodes) {
      n.x = Math.max(-1, Math.min(1, n.x + n.vx * heat / 0.05));
      n.y = Math.max(-1, Math.min(1, n.y + n.vy * heat / 0.05));
      n.vx = 0; n.vy = 0;
    }
  }
  return nodes;
}
