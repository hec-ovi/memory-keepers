// The dream movie: the night's knowledge graph plays back on a full-screen
// canvas; nodes surface in weight order, connections draw themselves, then
// the narrative fades in.
import { layout } from "../sim/graphlayout.js";

const KIND_COLOR = {
  keeper: "#ffb545", book: "#8ec9e8", entity: "#57e6ff", tag: "#9a8cf0",
};

export class DreamMovie {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector("#dream-canvas");
    this.narrativeEl = root.querySelector("#dream-narrative");
    this.skipButton = root.querySelector("#dream-skip");
  }

  play(report, onDone) {
    const positioned = layout(report.graph);
    const byId = Object.fromEntries(positioned.map((n) => [n.id, n]));
    const edges = report.graph.edges.filter((e) => byId[e.source] && byId[e.target]);
    const order = [...positioned].sort((a, b) => (b.weight || 1) - (a.weight || 1));
    const appearAt = Object.fromEntries(order.map((n, i) => [n.id, i * 0.22]));
    const total = order.length * 0.22 + 3.5;

    this.root.hidden = false;
    this.narrativeEl.textContent = report.narrative || "";
    this.narrativeEl.style.opacity = 0;
    const ctx = this.canvas.getContext("2d");
    let start = null, raf = null;

    const finish = () => {
      cancelAnimationFrame(raf);
      this.root.hidden = true;
      this.skipButton.onclick = null;
      onDone?.();
    };
    this.skipButton.onclick = finish;

    const draw = (now) => {
      if (start === null) start = now;
      const t = (now - start) / 1000;
      const w = this.canvas.width = innerWidth;
      const h = this.canvas.height = innerHeight;
      const cx = w / 2, cy = h / 2 - h * 0.06;
      const scale = Math.min(w, h) * 0.36;
      const px = (n) => cx + n.x * scale;
      const py = (n) => cy + n.y * scale;
      ctx.clearRect(0, 0, w, h);

      for (const e of edges) {
        const a = byId[e.source], b = byId[e.target];
        const born = Math.max(appearAt[a.id], appearAt[b.id]) + 0.3;
        if (t < born) continue;
        const grow = Math.min(1, (t - born) / 0.7);
        ctx.strokeStyle = e.kind === "derived_from"
          ? "rgba(154,140,240,0.65)" : "rgba(87,230,255,0.28)";
        ctx.lineWidth = e.kind === "derived_from" ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(a) + (px(b) - px(a)) * grow, py(a) + (py(b) - py(a)) * grow);
        ctx.stroke();
      }
      for (const n of positioned) {
        const born = appearAt[n.id];
        if (t < born) continue;
        const pop = Math.min(1, (t - born) / 0.5);
        const radius = (4 + Math.min(n.weight || 1, 6) * 2.2) * (0.6 + 0.4 * pop);
        ctx.globalAlpha = pop;
        ctx.fillStyle = KIND_COLOR[n.kind] || "#fff";
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 18 * pop;
        ctx.beginPath();
        ctx.arc(px(n), py(n), radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (n.kind !== "book" || (n.weight || 1) > 1) {
          ctx.fillStyle = "rgba(235,228,255,0.85)";
          ctx.font = "12px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(n.label, px(n), py(n) + radius + 14);
        }
        ctx.globalAlpha = 1;
      }
      if (t > total - 3) this.narrativeEl.style.opacity = 1;
      if (t > total + 2.5) return finish();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
  }
}
