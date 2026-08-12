import { describe, expect, it } from "vitest";
import { computeGraphLayout, edgeId } from "../src/sim/graphlayout.js";

// Small fixture matching the dream report graph shape (dreaming/CONTRACT.md): 3 keepers, their books,
// bridging entities, mixed-weight edges.
const fixtureGraph = () => ({
  nodes: [
    { id: "keeper:dreams", kind: "keeper", label: "Keeper of Dreams", keeper_id: "dreams", weight: 5 },
    { id: "keeper:movies", kind: "keeper", label: "Keeper of Movies", keeper_id: "movies", weight: 4 },
    { id: "keeper:fears", kind: "keeper", label: "Keeper of Fears", keeper_id: "fears", weight: 3 },
    { id: "book:dreams/b1", kind: "book", label: "Flying over water", keeper_id: "dreams", weight: 2 },
    { id: "book:dreams/b2", kind: "book", label: "Falling", keeper_id: "dreams", weight: 1 },
    { id: "book:movies/m1", kind: "book", label: "Interstellar night", keeper_id: "movies", weight: 2 },
    { id: "book:fears/f1", kind: "book", label: "Deep water", keeper_id: "fears", weight: 1 },
    { id: "entity:Interstellar", kind: "entity", label: "Interstellar", weight: 3 },
    { id: "entity:Ocean", kind: "entity", label: "Ocean", weight: 2 },
  ],
  edges: [
    { source: "book:dreams/b1", target: "entity:Ocean", kind: "mentions", weight: 1 },
    { source: "book:fears/f1", target: "entity:Ocean", kind: "mentions", weight: 1 },
    { source: "book:movies/m1", target: "entity:Interstellar", kind: "mentions", weight: 1 },
    { source: "book:dreams/b1", target: "entity:Interstellar", kind: "mentions", weight: 1 },
    { source: "book:dreams/b1", target: "book:movies/m1", kind: "shared_entity", label: "Interstellar", weight: 2 },
    { source: "book:dreams/b1", target: "book:fears/f1", kind: "shared_entity", label: "Ocean", weight: 3 },
  ],
});

// Bigger deterministic graph to stress stability and clustering.
function bigGraph() {
  const keepers = ["alpha", "beta", "gamma", "delta"];
  const nodes = [];
  const edges = [];
  for (const a of keepers) {
    nodes.push({ id: `keeper:${a}`, kind: "keeper", label: a, keeper_id: a, weight: 5 });
  }
  for (const a of keepers) {
    for (let i = 0; i < 10; i++) {
      nodes.push({ id: `book:${a}/${i}`, kind: "book", label: `${a} ${i}`, keeper_id: a, weight: 1 + (i % 3) });
    }
  }
  for (let e = 0; e < 12; e++) {
    nodes.push({ id: `entity:E${e}`, kind: "entity", label: `E${e}`, weight: 1 + (e % 4) });
  }
  let k = 0;
  for (const a of keepers) {
    for (let i = 0; i < 10; i++) {
      edges.push({ source: `book:${a}/${i}`, target: `entity:E${k % 12}`, kind: "mentions", weight: 1 + (k % 3) });
      k++;
      edges.push({ source: `book:${a}/${i}`, target: `entity:E${(k * 7) % 12}`, kind: "mentions", weight: 1 });
      k++;
    }
  }
  return { nodes, edges };
}

const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);

describe("edgeId", () => {
  it("edgeId is stable and unique per index", () => {
    const e = { source: "a", target: "b", kind: "mentions" };
    expect(edgeId(e, 0)).toBe(edgeId(e, 0));
    expect(edgeId(e, 0)).not.toBe(edgeId(e, 1));
  });
});

describe("layout determinism", () => {
  it("same graph -> identical positions and timeline", () => {
    const one = computeGraphLayout(fixtureGraph());
    const two = computeGraphLayout(JSON.parse(JSON.stringify(fixtureGraph())));
    expect(Object.fromEntries(two.positions)).toEqual(Object.fromEntries(one.positions));
    expect(two.timeline).toEqual(one.timeline);
  });

  it("covers every node with a position", () => {
    const graph = fixtureGraph();
    const { positions } = computeGraphLayout(graph);
    expect(positions.size).toBe(graph.nodes.length);
    for (const node of graph.nodes) expect(positions.has(node.id)).toBe(true);
  });

  it("handles an empty graph", () => {
    const { positions, timeline } = computeGraphLayout({ nodes: [], edges: [] });
    expect(positions.size).toBe(0);
    expect(timeline).toEqual([]);
  });
});

describe("layout stability", () => {
  it("produces no NaN and stays within the bound on the big graph", () => {
    const { positions } = computeGraphLayout(bigGraph());
    for (const p of positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
      expect(Math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2)).toBeLessThanOrEqual(40.001);
    }
  });

  it("separates coincident and unlinked nodes", () => {
    const graph = {
      nodes: [
        { id: "entity:A", kind: "entity", label: "A", weight: 1 },
        { id: "entity:B", kind: "entity", label: "B", weight: 1 },
      ],
      edges: [],
    };
    const { positions } = computeGraphLayout(graph);
    expect(dist(positions.get("entity:A"), positions.get("entity:B"))).toBeGreaterThan(0.5);
  });
});

describe("cluster sanity", () => {
  it("books sit nearer their own keeper than other keepers on average", () => {
    const graph = bigGraph();
    const { positions } = computeGraphLayout(graph);
    const keeperIds = graph.nodes.filter((n) => n.kind === "keeper").map((n) => n.keeper_id);
    let own = 0;
    let other = 0;
    let ownCount = 0;
    let otherCount = 0;
    for (const node of graph.nodes) {
      if (node.kind !== "book") continue;
      const p = positions.get(node.id);
      for (const keeperId of keeperIds) {
        const d = dist(p, positions.get(`keeper:${keeperId}`));
        if (keeperId === node.keeper_id) {
          own += d;
          ownCount++;
        } else {
          other += d;
          otherCount++;
        }
      }
    }
    expect(own / ownCount).toBeLessThan(other / otherCount);
  });
});

describe("assembly timeline", () => {
  it("t values are strictly increasing, normalized to (0, 1], ending at 1", () => {
    const { timeline } = computeGraphLayout(fixtureGraph());
    expect(timeline.length).toBeGreaterThan(0);
    let prev = 0;
    for (const wave of timeline) {
      expect(wave.t).toBeGreaterThan(prev);
      expect(wave.t).toBeLessThanOrEqual(1);
      prev = wave.t;
    }
    expect(timeline[timeline.length - 1].t).toBe(1);
  });

  it("covers every node exactly once and every edge exactly once", () => {
    const graph = fixtureGraph();
    const { timeline } = computeGraphLayout(graph);
    const nodeIds = timeline.flatMap((w) => w.nodeIds ?? []);
    const edgeIds = timeline.flatMap((w) => w.edgeIds ?? []);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
    expect([...nodeIds].sort()).toEqual(graph.nodes.map((n) => n.id).sort());
    expect([...edgeIds].sort()).toEqual(graph.edges.map((e, i) => edgeId(e, i)).sort());
  });

  it("orders keepers first, then books, then entities, then edges", () => {
    const graph = fixtureGraph();
    const { timeline } = computeGraphLayout(graph);
    const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    const rank = { keeper: 0, book: 1, entity: 2 };
    let prevRank = -1;
    let sawEdges = false;
    for (const wave of timeline) {
      if (wave.edgeIds) {
        sawEdges = true;
        continue;
      }
      expect(sawEdges).toBe(false); // node waves never follow edge waves
      const kinds = new Set(wave.nodeIds.map((id) => kindOf.get(id)));
      expect(kinds.size).toBe(1); // waves never mix kinds
      const r = rank[[...kinds][0]];
      expect(r).toBeGreaterThanOrEqual(prevRank);
      prevRank = r;
    }
    expect(sawEdges).toBe(true);
    expect(timeline[0].nodeIds).toContain("keeper:dreams");
  });

  it("plays edge waves by weight descending", () => {
    const graph = fixtureGraph();
    const { timeline } = computeGraphLayout(graph);
    const weightById = new Map(graph.edges.map((e, i) => [edgeId(e, i), e.weight ?? 1]));
    const waveWeights = timeline
      .filter((w) => w.edgeIds)
      .map((w) => {
        const weights = new Set(w.edgeIds.map((id) => weightById.get(id)));
        expect(weights.size).toBe(1); // one weight tier per wave
        return [...weights][0];
      });
    expect(waveWeights.length).toBeGreaterThan(1);
    for (let i = 1; i < waveWeights.length; i++) {
      expect(waveWeights[i]).toBeLessThan(waveWeights[i - 1]);
    }
  });

  it("groups each keeper's books into their own wave, in keeper order", () => {
    const graph = fixtureGraph();
    const { timeline } = computeGraphLayout(graph);
    const bookWaves = timeline.filter(
      (w) => w.nodeIds && w.nodeIds.every((id) => id.startsWith("book:")),
    );
    expect(bookWaves.length).toBe(3); // one per keeper with books
    for (const wave of bookWaves) {
      const owners = new Set(
        wave.nodeIds.map((id) => graph.nodes.find((n) => n.id === id).keeper_id),
      );
      expect(owners.size).toBe(1);
    }
  });
});
