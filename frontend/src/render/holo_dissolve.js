// The monument's disintegration figure: her body sampled once into a static
// point cloud whose motion lives entirely in the vertex shader. Nothing else
// draws her: she exists only as her dust. A release band travels up the
// figure; particles inside it drift off and burn brighter, the rest hold the
// surface densely enough to keep her silhouette from across the plaza.
//
// GPU cost is deliberately small: one draw call, a fixed point budget,
// no compute pass and no per-frame attribute writes; update() only
// advances a time uniform.

import * as THREE from "three";

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uPointSize;
  uniform float uPixelRatio;
  uniform float uDissolve;
  attribute float aSeed;
  attribute vec3 aTint;
  varying vec3 vColor;
  varying float vAlpha;

  // The multiplier is kept small on purpose: scaled into the tens of
  // thousands, a 32 bit float has no fraction left and the hash collapses
  // onto a couple of hundred values.
  float hash11(float value) {
    return fract(sin(value * 78.233) * 4375.85453);
  }

  void main() {
    float band = sin(position.y * 9.0 + aSeed * 23.0 - uTime * 1.05);
    float release = smoothstep(0.68, 0.98, band * 0.5 + 0.5);
    vec3 displaced = position;
    displaced.x += release * (0.03 + aSeed * 0.12) * uDissolve;
    displaced.y += release * (0.05 + aSeed * 0.16) * uDissolve;
    displaced.z += sin(uTime + aSeed * 31.0) * release * 0.05 * uDissolve;

    vec4 view = modelViewMatrix * vec4(displaced, 1.0);
    gl_Position = projectionMatrix * view;
    float perspective = clamp(6.0 / max(1.0, -view.z), 0.5, 1.6);
    gl_PointSize = uPointSize * uPixelRatio * perspective * (0.7 + aSeed * 0.6);

    vColor = aTint * (0.85 + release * 0.9 + aSeed * 0.25);
    // Held particles stay near-opaque to carry the whole silhouette in full
    // daylight (no mesh backs them up); released ones flicker as they drift.
    vAlpha = (0.72 + release * 0.28) *
      (0.72 + 0.28 * step(hash11(aSeed * 7.3 + floor(uTime * 5.0)), 0.6));
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float radius = length(gl_PointCoord - vec2(0.5));
    float edge = 1.0 - smoothstep(0.22, 0.5, radius);
    if (edge <= 0.01) discard;
    gl_FragColor = vec4(vColor, vAlpha * edge);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function deterministicRandom(index, salt = 0) {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

// A particle's colour, from the mesh it sits on. Glowing surfaces (emissive
// eyes, the tone-unmapped highlights) go near-white so the face reads across
// the plaza; everything else is the material colour graded by `grade`, which
// darkens the porcelain body into a figure that stands off the sunlit island.
function meshTint(material, grade) {
  const color = material?.color ? material.color.clone() : new THREE.Color(1, 1, 1);
  // Intensity alone is not glow: standard materials default to intensity 1
  // with a black emissive, so the emissive colour must weigh in too.
  const emissive = material?.emissive;
  const glow = (material?.emissiveIntensity ?? 0) *
    (emissive ? Math.max(emissive.r, emissive.g, emissive.b) : 0);
  if (glow > 0.3 || material?.toneMapped === false) {
    return color.lerp(new THREE.Color(0xffffff), 0.65);
  }
  return color.multiply(grade);
}

// Samples `count` points spread evenly over the visible mesh surfaces under
// `source`, in source-local space; each sample is { position, tint } (see
// meshTint). Vertices alone are too few and too uneven (a keeper is ~2k
// vertices, most of them in the eyes): picking triangles by area and a
// barycentric point inside each fills any budget with even skin density.
// Deterministic, so the figure is the same on every build.
export function sampleSurfacePoints(source, count, grade = new THREE.Color(1, 1, 1)) {
  source.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(source.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const triangles = []; // flat corner coords + cumulative area
  let totalArea = 0;
  source.traverse((obj) => {
    if (!obj.isMesh || obj.visible === false) return;
    const positions = obj.geometry?.getAttribute?.("position");
    if (!positions) return;
    relative.multiplyMatrices(inverse, obj.matrixWorld);
    const tint = meshTint(
      Array.isArray(obj.material) ? obj.material[0] : obj.material, grade);
    const index = obj.geometry.getIndex();
    const vertexCount = index ? index.count : positions.count;
    for (let v = 0; v + 2 < vertexCount; v += 3) {
      for (let c = 0; c < 3; c += 1) {
        corners[c]
          .fromBufferAttribute(positions, index ? index.getX(v + c) : v + c)
          .applyMatrix4(relative);
      }
      const area = corners[2].clone().sub(corners[0])
        .cross(corners[1].clone().sub(corners[0])).length() / 2;
      if (area <= 0) continue;
      totalArea += area;
      triangles.push({
        a: corners[0].clone(), b: corners[1].clone(), c: corners[2].clone(),
        tint, upTo: totalArea,
      });
    }
  });
  if (triangles.length === 0) return [];

  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const pick = deterministicRandom(i, 7) * totalArea;
    let lo = 0;
    let hi = triangles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (triangles[mid].upTo < pick) lo = mid + 1;
      else hi = mid;
    }
    const { a, b, c, tint } = triangles[lo];
    const su = Math.sqrt(deterministicRandom(i, 11));
    const v = deterministicRandom(i, 13);
    const position = new THREE.Vector3()
      .addScaledVector(a, 1 - su)
      .addScaledVector(b, su * (1 - v))
      .addScaledVector(c, su * v);
    samples.push({ position, tint });
  }
  return samples;
}

// Builds the dust figure over every visible mesh under `source` (in
// source-local space, so the cloud scales and turns with her) and adds the
// points object to it. Returns { object, update(dt), dispose() } or null
// with nothing to sample.
export function createHoloDissolve({
  source,
  maxPoints = 2200,
  pointSize = 2.4,
  dissolve = 0.55,
  tint = 0x4aa8d8,
} = {}) {
  const samples = sampleSurfacePoints(source, maxPoints, new THREE.Color(tint));
  if (samples.length === 0) return null;

  const count = samples.length;
  const positions = new Float32Array(count * 3);
  const tints = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const { position, tint: c } = samples[index];
    positions[index * 3] = position.x;
    positions[index * 3 + 1] = position.y;
    positions[index * 3 + 2] = position.z;
    tints[index * 3] = c.r;
    tints[index * 3 + 1] = c.g;
    tints[index * 3 + 2] = c.b;
    seeds[index] = deterministicRandom(index, 17);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aTint", new THREE.BufferAttribute(tints, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPointSize: { value: pointSize },
      uPixelRatio: { value: Math.min(globalThis.devicePixelRatio || 1, 1.6) },
      uDissolve: { value: dissolve },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // Normal blending, not additive: added light disappears against the
    // sunlit island; covering pixels is what keeps her visible by day.
    blending: THREE.NormalBlending,
  });

  const object = new THREE.Points(geometry, material);
  object.frustumCulled = false;
  // After the transparent street ribbons (renderOrder 1), which write no
  // depth and would otherwise paint over her.
  object.renderOrder = 6;
  source.add(object);

  let time = 0;
  return {
    object,
    count,
    update(dt) {
      time += dt;
      material.uniforms.uTime.value = time;
    },
    dispose() {
      object.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
