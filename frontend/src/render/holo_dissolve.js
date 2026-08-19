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
  uniform vec3 uTint;
  attribute float aSeed;
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

    vColor = uTint * (0.8 + release * 0.9 + aSeed * 0.25);
    // Held particles stay bright enough to carry the whole silhouette (no
    // mesh backs them up); released ones flicker and burn brighter still.
    vAlpha = (0.4 + release * 0.45) *
      (0.65 + 0.35 * step(hash11(aSeed * 7.3 + floor(uTime * 5.0)), 0.6));
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

// Thins sample points to a budget with even density in space. A plain stride
// spends the budget where the modelling detail is (eyes, ears) and leaves the
// body bare; bucketing by position and taking round-robin from every bucket
// spreads it over the volume instead.
export function thinToUniformDensity(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const bounds = new THREE.Box3();
  for (const p of points) bounds.expandByPoint(p);
  const size = bounds.getSize(new THREE.Vector3());
  const volume = Math.max(size.x * size.y * size.z, 1e-6);
  const cell = Math.max(Math.cbrt(volume / maxPoints), 1e-4);

  const buckets = new Map();
  for (const p of points) {
    const key = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}:${Math.floor(p.z / cell)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p);
    else buckets.set(key, [p]);
  }

  const lists = [...buckets.values()];
  const kept = [];
  for (let round = 0; kept.length < maxPoints; round += 1) {
    let added = 0;
    for (const list of lists) {
      if (round < list.length) {
        kept.push(list[round]);
        added += 1;
        if (kept.length >= maxPoints) break;
      }
    }
    if (added === 0) break;
  }
  return kept;
}

// Samples every visible mesh under `source` (in source-local space, so the
// cloud scales and turns with her) and adds the points object to it.
// Returns { object, update(dt), dispose() } or null with nothing to sample.
export function createHoloDissolve({
  source,
  maxPoints = 2200,
  pointSize = 2.4,
  dissolve = 0.55,
  tint = 0x8fd8ff,
} = {}) {
  source.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(source.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  const scratch = new THREE.Vector3();
  let samples = [];
  source.traverse((obj) => {
    if (!obj.isMesh || obj.visible === false) return;
    const positions = obj.geometry?.getAttribute?.("position");
    if (!positions) return;
    relative.multiplyMatrices(inverse, obj.matrixWorld);
    for (let index = 0; index < positions.count; index += 1) {
      scratch.fromBufferAttribute(positions, index);
      scratch.applyMatrix4(relative);
      samples.push(scratch.clone());
    }
  });
  if (samples.length === 0) return null;
  samples = thinToUniformDensity(samples, maxPoints);

  const count = samples.length;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = samples[index].x;
    positions[index * 3 + 1] = samples[index].y;
    positions[index * 3 + 2] = samples[index].z;
    seeds[index] = deterministicRandom(index, 17);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const color = new THREE.Color(tint);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPointSize: { value: pointSize },
      uPixelRatio: { value: Math.min(globalThis.devicePixelRatio || 1, 1.6) },
      uDissolve: { value: dissolve },
      uTint: { value: new THREE.Vector3(color.r, color.g, color.b) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const object = new THREE.Points(geometry, material);
  object.frustumCulled = false;
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
