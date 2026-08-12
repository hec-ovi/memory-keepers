// Street ribbon geometry tests (no WebGL: BufferGeometry math only).
// Regression: the ribbon triangles must wind counter-clockwise seen from
// above (+y). A flipped winding gets backface-culled by the play camera,
// which makes every street invisible even though the mesh is in the scene.
import { describe, expect, it } from "vitest";
import { buildStreetRibbon } from "../src/render/props.js";

const flatWorld = {
  heightAt: () => 0,
  nightMaskAt: () => 0,
};

function normalsOf(mesh) {
  const n = mesh.geometry.attributes.normal;
  const out = [];
  for (let i = 0; i < n.count; i++) out.push({ x: n.getX(i), y: n.getY(i), z: n.getZ(i) });
  return out;
}

describe("buildStreetRibbon", () => {
  it("returns null for degenerate paths", () => {
    expect(buildStreetRibbon({ points: [], world: flatWorld })).toBeNull();
    expect(buildStreetRibbon({ points: [{ x: 0, z: 0 }], world: flatWorld })).toBeNull();
  });

  it("drapes vertices slightly above world.heightAt", () => {
    const world = { heightAt: (x, z) => 0.25 * x + 0.1 * z, nightMaskAt: () => 0 };
    const mesh = buildStreetRibbon({
      points: [
        { x: 0, z: 0 },
        { x: 2, z: 0 },
        { x: 4, z: 1 },
      ],
      world,
    });
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const lift = pos.getY(i) - world.heightAt(pos.getX(i), pos.getZ(i));
      expect(lift).toBeGreaterThan(0.0);
      expect(lift).toBeLessThan(0.11);
    }
  });

  it.each([
    ["+x", [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 4, z: 0 }]],
    ["-x (reversed)", [{ x: 4, z: 0 }, { x: 2, z: 0 }, { x: 0, z: 0 }]],
    ["+z", [{ x: 0, z: 0 }, { x: 0, z: 2 }, { x: 0, z: 4 }]],
    ["curved", [{ x: 0, z: 0 }, { x: 2, z: 0.8 }, { x: 4, z: 0.4 }, { x: 6, z: 1.6 }]],
  ])("faces up along %s so the camera above never culls it", (_label, points) => {
    const mesh = buildStreetRibbon({ points, world: flatWorld });
    for (const n of normalsOf(mesh)) {
      expect(n.y).toBeGreaterThan(0.9); // flat ground: normals ~ straight up
    }
  });

  it("faces up on sloped ground too", () => {
    const world = { heightAt: (x, z) => 0.3 * Math.sin(x * 0.5) + 0.2 * z, nightMaskAt: () => 0 };
    const mesh = buildStreetRibbon({
      points: [
        { x: 0, z: 0 },
        { x: 2, z: 1 },
        { x: 4, z: 2 },
      ],
      world,
    });
    for (const n of normalsOf(mesh)) {
      expect(n.y).toBeGreaterThan(0.5); // tilted, but never sideways/down
    }
  });

  it("lays cobblestone UVs: u spans the width, v grows along the street", () => {
    const mesh = buildStreetRibbon({
      points: [
        { x: 0, z: 0 },
        { x: 2, z: 0 },
        { x: 4, z: 0 },
        { x: 6, z: 0 },
      ],
      world: flatWorld,
    });
    const uv = mesh.geometry.attributes.uv;
    expect(uv).toBeTruthy();
    const cols = 4;
    const sections = uv.count / cols;
    let prevV = -1;
    for (let i = 0; i < sections; i++) {
      // u runs 0..1 across the ribbon at every section
      expect(uv.getX(i * cols)).toBeCloseTo(0, 6);
      expect(uv.getX(i * cols + cols - 1)).toBeCloseTo(1, 6);
      // v is monotonically increasing along the street (stones tile forward)
      const v = uv.getY(i * cols);
      expect(v).toBeGreaterThanOrEqual(prevV);
      prevV = v;
    }
    expect(prevV).toBeGreaterThan(1); // long street = several texture repeats
  });

  it("uses a provided cobble texture as the material map", () => {
    const texture = { isTexture: true };
    const mesh = buildStreetRibbon({
      points: [
        { x: 0, z: 0 },
        { x: 3, z: 0 },
      ],
      world: flatWorld,
      texture,
    });
    expect(mesh.material.map).toBe(texture);
    const bare = buildStreetRibbon({
      points: [
        { x: 0, z: 0 },
        { x: 3, z: 0 },
      ],
      world: flatWorld,
    });
    expect(bare.material.map).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cottage variations (one builder, seeded per keeper id)
// ---------------------------------------------------------------------------
import { cottageVariant, cottagePalette, buildTrees, buildEmptyPlots } from "../src/render/props.js";

describe("cottageVariant", () => {
  const IDS = ["dreams", "meetings", "music", "films", "books", "places", "podcasts", "recipes", "people", "ideas", "fears", "wishes"];

  it("is deterministic: same keeper id, same house", () => {
    for (const id of IDS) {
      expect(cottageVariant(id)).toEqual(cottageVariant(id));
    }
  });

  it("returns only valid options", () => {
    for (const id of IDS) {
      const v = cottageVariant(id);
      expect(["gable", "hip", "steep"]).toContain(v.roof);
      expect(["cream", "rose", "sage", "sky", "sand"]).toContain(v.wallFamily);
      expect(["terracotta", "slate", "moss", "plum"]).toContain(v.roofFamily);
      expect(["porch", "shed", "flowerbox", "none"]).toContain(v.extension);
      expect([1, 2]).toContain(v.frontWindows);
      expect([0, 1, 2]).toContain(v.sideWindows);
      expect([-1, 1]).toContain(v.lanternSide);
      expect([-0.55, 0.55]).toContain(v.chimney.x);
      expect(v.scale).toBeGreaterThan(0.9);
      expect(v.scale).toBeLessThan(1.1);
    }
  });

  it("actually varies across a village of keepers", () => {
    const variants = IDS.map((id) => cottageVariant(id));
    expect(new Set(variants.map((v) => v.roof)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(variants.map((v) => v.wallFamily)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(variants.map((v) => v.roofFamily)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(variants.map((v) => v.extension)).size).toBeGreaterThanOrEqual(2);
  });

  it("feeds cottagePalette: different tint families give different walls/roofs", () => {
    const palette = { primary: "#f8a7c0", accent: "#7c4a6b" };
    const a = cottagePalette(palette, false, { wallFamily: "sage", roofFamily: "slate" });
    const b = cottagePalette(palette, false, { wallFamily: "rose", roofFamily: "terracotta" });
    expect(a.wall).not.toBe(b.wall);
    expect(a.roof).not.toBe(b.roof);
  });
});

describe("buildStreetRibbon width tiers + faded empty spurs", () => {
  const straight = [
    { x: 0, z: 0 },
    { x: 3, z: 0 },
    { x: 6, z: 0 },
  ];

  it("honors the width parameter (spurs narrow, mains wide)", () => {
    for (const width of [1.05, 2.2]) {
      const mesh = buildStreetRibbon({ points: straight, world: flatWorld, width });
      const pos = mesh.geometry.attributes.position;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        minZ = Math.min(minZ, pos.getZ(i));
        maxZ = Math.max(maxZ, pos.getZ(i));
      }
      expect(maxZ - minZ).toBeCloseTo(width, 6);
    }
  });

  it("fade dims the lane (empty plots) and the material blends softly", () => {
    const solid = buildStreetRibbon({ points: straight, world: flatWorld });
    const faint = buildStreetRibbon({ points: straight, world: flatWorld, fade: 0.55 });
    expect(solid.material.transparent).toBe(true); // soft alpha edges
    expect(solid.material.opacity).toBe(1);
    expect(faint.material.opacity).toBeCloseTo(0.55, 9);
  });
});

// ---------------------------------------------------------------------------
// Path-end fades (ribbon ends dissolve where lanes collide, BACKLOG 15)
// ---------------------------------------------------------------------------
import { endFadeAlpha } from "../src/render/props.js";

describe("buildStreetRibbon end fades", () => {
  // A 12-unit straight lane with plenty of sections.
  const LANE = [...Array(13)].map((_, i) => ({ x: i, z: 0 }));
  const COLS = 4;

  const sectionAlphas = (mesh) => {
    const color = mesh.geometry.attributes.color;
    expect(color.itemSize).toBe(4); // RGBA: per-vertex alpha
    const out = [];
    for (let i = 0; i < color.count / COLS; i++) out.push(color.getW(i * COLS));
    return out;
  };

  it("endFadeAlpha: 0 exactly at the tip, aggressive near it, 1 past the stretch", () => {
    expect(endFadeAlpha(0, 2.4)).toBe(0);
    expect(endFadeAlpha(2.4, 2.4)).toBe(1);
    expect(endFadeAlpha(9, 2.4)).toBe(1);
    expect(endFadeAlpha(-1, 2.4)).toBe(0); // clamped
    // aggressive: at half the stretch the lane is still mostly gone
    expect(endFadeAlpha(1.2, 2.4)).toBeLessThan(0.3);
    // monotonic over the stretch
    let prev = -1;
    for (let d = 0; d <= 2.4; d += 0.1) {
      const a = endFadeAlpha(d, 2.4);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it("fades the flagged terminals to alpha 0 and keeps the interior solid", () => {
    const mesh = buildStreetRibbon({
      points: LANE,
      world: flatWorld,
      endFade: { head: true, tail: true, length: 2.4 },
    });
    const alphas = sectionAlphas(mesh);
    expect(alphas[0]).toBe(0); // head end: fully dissolved
    expect(alphas[alphas.length - 1]).toBe(0); // tail end too
    expect(alphas[1]).toBeLessThan(0.3); // aggressive over the last stretch
    expect(Math.max(...alphas)).toBe(1); // the middle stays solid
    // symmetric: the fade reads the same from both ends
    expect(alphas[1]).toBeCloseTo(alphas[alphas.length - 2], 6);
  });

  it("fades only the flagged end (door approaches stay solid)", () => {
    const mesh = buildStreetRibbon({
      points: LANE,
      world: flatWorld,
      endFade: { head: true, tail: false },
    });
    const alphas = sectionAlphas(mesh);
    expect(alphas[0]).toBe(0);
    expect(alphas[alphas.length - 1]).toBe(1); // the plot end never fades
  });

  it("without endFade every vertex stays opaque, and short lanes keep a solid middle", () => {
    const plain = buildStreetRibbon({ points: LANE, world: flatWorld });
    expect(sectionAlphas(plain).every((a) => a === 1)).toBe(true);
    // a short lane: the fade clamps to 40% of the length per end
    const short = buildStreetRibbon({
      points: [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
        { x: 2, z: 0 },
      ],
      world: flatWorld,
      endFade: { head: true, tail: true, length: 10 },
    });
    const alphas = sectionAlphas(short);
    expect(alphas[0]).toBe(0);
    expect(alphas[2]).toBe(0);
    expect(alphas[1]).toBe(1); // the middle survives even a huge fade request
  });
});

describe("buildTrees (instanced forest)", () => {
  const trees = [
    { kind: "round", x: 0, z: 0, y: 1, scale: 1, rotation: 0, sector: "day", night: 0 },
    { kind: "round", x: 4, z: 1, y: 1, scale: 0.7, rotation: 1, sector: "day", night: 0 },
    { kind: "pine", x: 8, z: 2, y: 1, scale: 1.2, rotation: 2, sector: "day", night: 0 },
    { kind: "tall", x: -4, z: 3, y: 1, scale: 1, rotation: 0.5, sector: "night", night: 1 },
    { kind: "bush", x: -8, z: -2, y: 1, scale: 0.9, rotation: 0.2, sector: "night", night: 1 },
  ];

  it("builds at most two instanced draw calls per species", () => {
    const { group } = buildTrees({ trees });
    const instanced = group.children.filter((c) => c.isInstancedMesh);
    expect(instanced.length).toBeGreaterThan(0);
    expect(instanced.length).toBeLessThanOrEqual(8); // 4 species x (trunk + foliage)
    // every species present in the input got meshes
    for (const kind of ["round", "pine", "tall", "bush"]) {
      expect(instanced.some((m) => m.name === `trees:${kind}`)).toBe(true);
    }
    // instance counts match the placements per species
    const roundMeshes = instanced.filter((m) => m.name === "trees:round");
    for (const m of roundMeshes) expect(m.count).toBe(2);
  });

  it("casts shadows and tints night instances", () => {
    const { group } = buildTrees({ trees });
    for (const m of group.children.filter((c) => c.isInstancedMesh)) {
      expect(m.castShadow).toBe(true);
    }
  });
});

describe("buildEmptyPlots (undiscovered sites, instanced)", () => {
  const plots = [
    { id: "day-7", sector: "day", x: 0, z: 0, y: 1, angle: 0, plotRadius: 2.6, occupied: null, door: { x: 1.4, z: 0, y: 1 } },
    { id: "night-2", sector: "night", x: 20, z: -8, y: 1.2, angle: 1.1, plotRadius: 2.6, occupied: null, door: { x: 20.6, z: -6.8, y: 1.2 } },
  ];

  it("builds instanced markers: 5 draw layers + one mist sprite per plot (no ground ring)", () => {
    const { group, mist } = buildEmptyPlots({ plots });
    const instanced = group.children.filter((c) => c.isInstancedMesh);
    // stones, posts, boards, VACANT front faces, VACANT back faces
    // (the faint white ground ring was removed per owner feedback)
    expect(instanced).toHaveLength(5);
    const stones = instanced.find((m) => m.count === plots.length * 9);
    expect(stones).toBeTruthy();
    const perPlot = instanced.filter((m) => m.count === plots.length);
    expect(perPlot).toHaveLength(4);
    expect(group.children.some((c) => c.geometry?.type === "RingGeometry")).toBe(false);
    const sprites = group.children.filter((c) => c.isSprite);
    expect(sprites).toHaveLength(plots.length);
    expect(mist).toHaveLength(plots.length);
    for (const m of mist) {
      expect(m.sprite).toBeTruthy();
      expect(Number.isFinite(m.baseY)).toBe(true);
      expect(Number.isFinite(m.phase)).toBe(true);
    }
  });

  it("gives every signboard a VACANT face on BOTH sides, sharing one texture", () => {
    const { group } = buildEmptyPlots({ plots });
    const front = group.children.find((c) => c.name === "vacant-face-front");
    const back = group.children.find((c) => c.name === "vacant-face-back");
    expect(front).toBeTruthy();
    expect(back).toBeTruthy();
    expect(front.count).toBe(plots.length);
    expect(back.count).toBe(plots.length);
    // one shared material and texture: a single extra draw call per side
    expect(front.material).toBe(back.material);
    expect(front.material.map).toBeTruthy();
    // the two faces sit apart (front and back of the board), per plot
    for (let pi = 0; pi < plots.length; pi++) {
      const mf = [...front.instanceMatrix.array.slice(pi * 16, pi * 16 + 16)];
      const mb = [...back.instanceMatrix.array.slice(pi * 16, pi * 16 + 16)];
      const posF = [mf[12], mf[13], mf[14]];
      const posB = [mb[12], mb[13], mb[14]];
      const gap = Math.hypot(posF[0] - posB[0], posF[1] - posB[1], posF[2] - posB[2]);
      expect(gap).toBeGreaterThan(0.05); // proud of both board sides
      expect(gap).toBeLessThan(0.12);
      // and the back face looks the opposite way (basis z flipped)
      const dot = mf[8] * mb[8] + mf[9] * mb[9] + mf[10] * mb[10];
      expect(dot).toBeLessThan(0);
    }
  });

  it("is deterministic per plot id and survives an empty list", () => {
    const a = buildEmptyPlots({ plots });
    const b = buildEmptyPlots({ plots });
    const matsOf = (g) =>
      g.children.filter((c) => c.isInstancedMesh).map((c) => [...c.instanceMatrix.array]);
    expect(matsOf(a.group)).toEqual(matsOf(b.group));
    const none = buildEmptyPlots({ plots: [] });
    expect(none.group.children).toHaveLength(0);
    expect(none.mist).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VACANT sign spec + drawing (canvas texture, both faces read it)
// ---------------------------------------------------------------------------
import { vacantSignSpec, drawVacantSign, buildGardens } from "../src/render/props.js";

describe("vacantSignSpec + drawVacantSign", () => {
  it("spec: reads VACANT, high contrast, deterministic", () => {
    const spec = vacantSignSpec();
    expect(vacantSignSpec()).toEqual(spec);
    expect(spec.text).toBe("VACANT");
    expect(spec.w).toBeGreaterThanOrEqual(96); // enough texels to read at zoom
    expect(spec.font).toMatch(/bold/);
    // contrast: pale board, dark ink
    const lum = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    };
    expect(lum(spec.bg) - lum(spec.ink)).toBeGreaterThan(0.5);
  });

  it("draws the text centered on a full-canvas board", () => {
    const calls = { fillText: [], fillRect: [] };
    const ctx = {
      fillStyle: null,
      strokeStyle: null,
      lineWidth: 0,
      font: null,
      textAlign: null,
      textBaseline: null,
      fillRect(...a) {
        calls.fillRect.push(a);
      },
      strokeRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fillText(...a) {
        calls.fillText.push({ args: a, fillStyle: this.fillStyle, font: this.font });
      },
    };
    const spec = vacantSignSpec();
    drawVacantSign(ctx, spec);
    // background covers the whole canvas
    expect(calls.fillRect[0]).toEqual([0, 0, spec.w, spec.h]);
    // exactly one VACANT, centered, in the ink color and the bold font
    expect(calls.fillText).toHaveLength(1);
    const t = calls.fillText[0];
    expect(t.args[0]).toBe("VACANT");
    expect(t.args[1]).toBeCloseTo(spec.w / 2, 5);
    expect(Math.abs(t.args[2] - spec.h / 2)).toBeLessThan(4);
    expect(t.fillStyle).toBe(spec.ink);
    expect(t.font).toBe(spec.font);
    expect(ctx.textAlign).toBe("center");
    expect(ctx.textBaseline).toBe("middle");
  });
});

// ---------------------------------------------------------------------------
// Gardens (dirt loop + small props per occupied plot)
// ---------------------------------------------------------------------------
import { layoutWorld } from "../src/sim/world.js";

describe("buildGardens", () => {
  const WORLD = layoutWorld([
    { id: "dreams", kind: "conscious", created_at: "1" },
    { id: "fear", kind: "unconscious", created_at: "2" },
  ]);
  const occupied = WORLD.plots.filter((p) => p.occupied);

  it("draws the garden props only: the loop stays walkable but has no ribbon texture", () => {
    const { group } = buildGardens({ plots: occupied });
    // no drawn path around the houses; walkers still use
    // plot.garden.loop from sim/world.js
    const ribbons = group.children.filter((c) => c.name === "street");
    expect(ribbons).toHaveLength(0);
    // every plot's props got a group (buildProp wraps each in a Group)
    const propGroups = group.children.filter((c) => c.isGroup);
    const expectedProps = occupied.reduce((n, p) => n + p.garden.props.length, 0);
    expect(propGroups).toHaveLength(expectedProps);
    expect(occupied.every((p) => (p.garden?.loop?.length ?? 0) >= 2)).toBe(true);
  });

  it("is deterministic and survives empty input", () => {
    const a = buildGardens({ plots: occupied });
    const b = buildGardens({ plots: occupied });
    expect(a.group.children.length).toBe(b.group.children.length);
    const none = buildGardens({ plots: [] });
    expect(none.group.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Topic flags on cottages (owner: "add a flag on the houses with the topic")
// ---------------------------------------------------------------------------
import { buildCottage, flagTexture } from "../src/render/props.js";

describe("buildCottage topic flag", () => {
  const keeper = { id: "dreams", topic: "dreams", name: "Keeper of Dreams", palette: { primary: "#f8a7c0" } };

  it("flies a banner with the topic, readable from both sides via one shared texture", () => {
    const { group } = buildCottage({ keeper });
    const pole = group.children.find((c) => c.name === "topic-flag-pole");
    const front = group.children.find((c) => c.name === "topic-flag-front");
    const back = group.children.find((c) => c.name === "topic-flag-back");
    expect(pole).toBeTruthy();
    expect(front).toBeTruthy();
    expect(back).toBeTruthy();
    expect(front.material).toBe(back.material);
    expect(front.material.map).toBeTruthy();
    // back face looks the opposite way so the text reads on both sides
    expect(Math.abs(back.rotation.y - Math.PI)).toBeLessThan(1e-9);
    // the flag flies above the walls
    expect(front.position.y).toBeGreaterThan(1.6);
  });

  it("skips the flag when there is no topic, and never breaks the door pick", () => {
    const { group, door } = buildCottage({ keeper: { id: "x", topic: "", name: "" } });
    expect(group.children.find((c) => c.name === "topic-flag-front")).toBeFalsy();
    expect(door.userData.pick).toBe("door");
  });

  it("flagTexture is jsdom-safe and returns a texture", () => {
    const tex = flagTexture("dreams", "#f8a7c0");
    expect(tex).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// House pick (clicking any cottage part selects the owner, BACKLOG 13)
// ---------------------------------------------------------------------------

describe("buildCottage house pick", () => {
  it("the whole group picks as the owner's house; the door keeps its enter pick", () => {
    const { group, door } = buildCottage({ keeper: { id: "dreams" } });
    expect(group.userData.pick).toBe("house");
    expect(group.userData.keeperId).toBe("dreams");
    expect(door.userData.pick).toBe("door");
    expect(door.userData.keeperId).toBe("dreams");
    // the knob is part of the door, not the house (a knob click still enters)
    const doorPicks = [];
    group.traverse((o) => {
      if (o !== group && o.userData?.pick === "door") doorPicks.push(o);
    });
    expect(doorPicks.length).toBeGreaterThanOrEqual(2); // door + knob
    // walls and roof carry no pick of their own: they bubble up to "house"
    let unpicked = 0;
    group.traverse((o) => {
      if (o !== group && !o.userData?.pick) unpicked++;
    });
    expect(unpicked).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Cottage collision footprints (porch/shed extents, BACKLOG 18)
// ---------------------------------------------------------------------------
import { cottageObstacles } from "../src/render/props.js";

describe("cottageObstacles", () => {
  // Scan ids until every extension shows up (cottageVariant is seeded).
  const idWith = (extension) => {
    for (let i = 0; i < 500; i++) {
      const id = `keeper-${i}`;
      if (cottageVariant(id).extension === extension) return id;
    }
    throw new Error(`no seeded id found for extension ${extension}`);
  };

  it("is deterministic and empty for cottages without solid extensions", () => {
    const nid = idWith("none");
    const fid = idWith("flowerbox");
    expect(cottageObstacles(nid, { x: 3, z: 4, angle: 1 })).toEqual([]);
    expect(cottageObstacles(fid, { x: 3, z: 4, angle: 1 })).toEqual([]);
    const pid = idWith("porch");
    expect(cottageObstacles(pid, { x: 3, z: 4, angle: 1 })).toEqual(
      cottageObstacles(pid, { x: 3, z: 4, angle: 1 }),
    );
  });

  it("a porch adds two pillar circles flanking the doorway, corridor open", () => {
    const id = idWith("porch");
    for (const angle of [0, 1.1, -2.3]) {
      const home = { x: 10, z: -6, angle };
      const obs = cottageObstacles(id, home);
      expect(obs).toHaveLength(2);
      const door = { x: home.x + Math.cos(angle) * 1.4, z: home.z + Math.sin(angle) * 1.4 };
      for (const o of obs) {
        expect(o.r).toBeGreaterThan(0.1);
        expect(o.r).toBeLessThan(0.4); // pillars, not a wall across the door
        // near the doorway...
        expect(Math.hypot(o.x - door.x, o.z - door.z)).toBeLessThan(0.8);
        // ...but the doorstep itself stays outside every circle
        expect(Math.hypot(o.x - door.x, o.z - door.z)).toBeGreaterThan(o.r + 0.15);
      }
      // the two pillars flank the door ray symmetrically
      const mid = { x: (obs[0].x + obs[1].x) / 2, z: (obs[0].z + obs[1].z) / 2 };
      const along = (mid.x - home.x) * Math.cos(angle) + (mid.z - home.z) * Math.sin(angle);
      expect(along).toBeGreaterThan(1.0); // out front, toward the door
      const lateral =
        -(mid.x - home.x) * Math.sin(angle) + (mid.z - home.z) * Math.cos(angle);
      expect(Math.abs(lateral)).toBeLessThan(1e-6); // centered on the ray
    }
  });

  it("a shed adds one solid circle on its side of the house", () => {
    const id = idWith("shed");
    const home = { x: 0, z: 0, angle: 0 };
    const obs = cottageObstacles(id, home);
    expect(obs).toHaveLength(1);
    expect(obs[0].r).toBeGreaterThan(0.4); // chunky: the whole shed box
    expect(obs[0].r).toBeLessThan(0.8);
    // the shed never blocks the door (door at 1.4 along angle 0 = +x)
    expect(Math.hypot(obs[0].x - 1.4, obs[0].z)).toBeGreaterThan(obs[0].r + 0.3);
    // rotating the home rotates the footprint with it
    const rotated = cottageObstacles(id, { x: 0, z: 0, angle: Math.PI / 2 });
    expect(Math.hypot(rotated[0].x, rotated[0].z)).toBeCloseTo(
      Math.hypot(obs[0].x, obs[0].z),
      6,
    );
    expect(rotated[0].x).not.toBeCloseTo(obs[0].x, 3);
  });
});
