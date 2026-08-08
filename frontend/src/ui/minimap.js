// RTS-style minimap: island silhouette, plots, live keepers, camera target.
// Click to jump the camera.
import { islandRadiusAt, ISLAND_RADIUS } from "../sim/plots.js";

const SCALE = 78 / ISLAND_RADIUS;

export class Minimap {
  constructor(canvas, { onJump }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - rect.width / 2) / SCALE;
      const z = (e.clientY - rect.top - rect.height / 2) / SCALE;
      onJump(x, z);
    });
    this.shore = [];
    for (let a = 0; a <= Math.PI * 2 + 0.05; a += 0.08) {
      this.shore.push([Math.cos(a) * islandRadiusAt(a), Math.sin(a) * islandRadiusAt(a)]);
    }
  }

  draw({ plots, keepersByPlot, walkers, cameraTarget }) {
    const { ctx } = this;
    const w = this.canvas.width, h = this.canvas.height;
    const cx = w / 2, cy = h / 2;
    ctx.clearRect(0, 0, w, h);

    ctx.beginPath();
    for (const [i, [x, z]] of this.shore.entries()) {
      i ? ctx.lineTo(cx + x * SCALE, cy + z * SCALE) : ctx.moveTo(cx + x * SCALE, cy + z * SCALE);
    }
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#241b45");
    grad.addColorStop(0.45, "#241b45");
    grad.addColorStop(0.6, "#3d5c33");
    grad.addColorStop(1, "#3d5c33");
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,181,69,0.5)";
    ctx.stroke();

    for (const plot of plots) {
      const keeper = keepersByPlot(plot.id);
      ctx.fillStyle = keeper ? (keeper.palette?.primary || "#fff")
        : "rgba(255,255,255,0.18)";
      ctx.beginPath();
      ctx.arc(cx + plot.x * SCALE, cy + plot.z * SCALE, keeper ? 3 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#fff";
    for (const walker of walkers) {
      ctx.fillRect(cx + walker.pos.x * SCALE - 1, cy + walker.pos.z * SCALE - 1, 2, 2);
    }
    ctx.strokeStyle = "#57e6ff";
    ctx.strokeRect(cx + cameraTarget.x * SCALE - 5, cy + cameraTarget.z * SCALE - 5, 10, 10);
  }
}
