// Optional post-processing for the overworld: a subtle bloom so emissive
// windows, lanterns and crystals glow at night. config.js is owned by another
// feature, so the flags live here; flip `bloom` off to skip the composer
// entirely (the renderer then draws directly, zero extra cost).

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export const overworldFlags = {
  bloom: true,
  bloomStrength: 0.3,
  bloomRadius: 0.5,
  // Above 1.0 so daylit ground never blooms; the camera-driven district
  // blend (render/blend.js envAt) lowers it over the night quarter so
  // emissives (windows, lanterns, crystals, wisps) glow there.
  bloomThreshold: 1.05,
};

// createBloomPipeline({renderer, scene, camera, width, height, flags})
// -> { render(), setSize(w, h), setEnv({bloomThreshold, bloomStrength}),
//      dispose() } for rendererWrap.setPipeline.
export function createBloomPipeline({ renderer, scene, camera, width = 1, height = 1, flags = overworldFlags }) {
  const composer = new EffectComposer(renderer);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    flags.bloomStrength,
    flags.bloomRadius,
    flags.bloomThreshold,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  return {
    render() {
      composer.render();
    },
    setSize(w, h) {
      composer.setSize(w, h);
    },
    // Crossfaded by the overworld scene as the camera moves between the
    // districts.
    setEnv({ bloomThreshold, bloomStrength } = {}) {
      if (Number.isFinite(bloomThreshold)) bloom.threshold = bloomThreshold;
      if (Number.isFinite(bloomStrength)) bloom.strength = bloomStrength;
    },
    dispose() {
      bloom.dispose();
      composer.dispose();
    },
  };
}
