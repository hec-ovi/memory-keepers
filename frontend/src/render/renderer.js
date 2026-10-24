// WebGLRenderer factory: color management, soft shadows, DPR cap, resize
// handling, and an optional post pipeline slot (see render/fx.js) so a scene
// can route frames through a composer without the renderer knowing about
// passes. No module-level side effects; everything lives inside the factory.

import * as THREE from "three";

export function createRenderer({ container, win = globalThis } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));

  const resizeHandlers = new Set();
  let pipeline = null; // optional composer wrapper: { render, setSize, dispose }

  function currentSize() {
    const w = container?.clientWidth || win.innerWidth || 1;
    const h = container?.clientHeight || win.innerHeight || 1;
    return { width: Math.max(1, w), height: Math.max(1, h) };
  }

  function applySize() {
    const { width, height } = currentSize();
    renderer.setSize(width, height);
    pipeline?.setSize?.(width, height);
    for (const fn of resizeHandlers) fn(width, height);
  }

  container?.appendChild(renderer.domElement);
  applySize();

  let observer = null;
  const onWinResize = () => applySize();
  if (typeof win.ResizeObserver === "function" && container) {
    observer = new win.ResizeObserver(() => applySize());
    observer.observe(container);
  } else {
    win.addEventListener?.("resize", onWinResize);
  }

  return {
    renderer,
    get domElement() {
      return renderer.domElement;
    },
    get size() {
      return currentSize();
    },
    render(scene, camera) {
      if (pipeline) pipeline.render();
      else renderer.render(scene, camera);
    },
    // Route frames through a post pipeline (null restores direct rendering).
    // The caller keeps ownership: dispose the pipeline after clearing it.
    setPipeline(p) {
      pipeline = p ?? null;
      if (pipeline?.setSize) {
        const { width, height } = currentSize();
        pipeline.setSize(width, height);
      }
    },
    get pipeline() {
      return pipeline;
    },
    // Subscribe to resizes: fn(width, height). Returns an unsubscribe.
    onResize(fn) {
      resizeHandlers.add(fn);
      fn(currentSize().width, currentSize().height);
      return () => resizeHandlers.delete(fn);
    },
    dispose() {
      observer?.disconnect();
      win.removeEventListener?.("resize", onWinResize);
      resizeHandlers.clear();
      pipeline = null;
      renderer.dispose();
      renderer.domElement?.remove?.();
    },
  };
}
