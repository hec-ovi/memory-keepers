// Speech bubbles above walking keepers, projected from world space.
export class BubbleLayer {
  constructor(root) {
    this.root = root;
    this.live = new Map(); // keeperId -> {el, until, keeperId}
  }

  say(keeperId, text, dark, seconds = 4.5) {
    this.live.get(keeperId)?.el.remove();
    const el = document.createElement("div");
    el.className = "bubble" + (dark ? " dark" : "");
    el.textContent = text;
    this.root.append(el);
    this.live.set(keeperId, { el, until: performance.now() + seconds * 1000 });
  }

  update(project, positions) {
    const now = performance.now();
    for (const [keeperId, bubble] of this.live) {
      const pos = positions(keeperId);
      if (!pos || now > bubble.until) {
        bubble.el.remove();
        this.live.delete(keeperId);
        continue;
      }
      const screen = project(pos.x, 2.3, pos.z);
      if (screen.behind) { bubble.el.style.opacity = 0; continue; }
      bubble.el.style.opacity = 1;
      bubble.el.style.left = screen.x + "px";
      bubble.el.style.top = screen.y + "px";
    }
  }
}
