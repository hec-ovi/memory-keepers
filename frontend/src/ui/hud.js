// Top-left controls: dreaming, new keeper, back-to-island. Pure DOM.
import { holoPanel, toast } from "./holo.js";

export class Hud {
  constructor({ root, api, onDreamReport, onWorldChanged, onExitInterior }) {
    this.root = root;
    this.api = api;
    this.onDreamReport = onDreamReport;
    this.onWorldChanged = onWorldChanged;

    const title = document.createElement("span");
    title.className = "hud-title";
    title.textContent = "memory keepers";

    this.dreamButton = this._button("☾ dream", () => this._dream());
    this.newButton = this._button("+ keeper", () => this._newKeeper());
    this.backButton = this._button("← island", onExitInterior);
    this.backButton.hidden = true;
    root.append(title, this.dreamButton, this.newButton, this.backButton);
  }

  _button(label, onClick) {
    const button = document.createElement("button");
    button.className = "hud-btn";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  setInterior(inside) {
    this.backButton.hidden = !inside;
    this.dreamButton.hidden = inside;
    this.newButton.hidden = inside;
  }

  async _dream() {
    const before = await this.api.dreamLatest().then((r) => r.run_id).catch(() => null);
    try {
      await this.api.dream();
    } catch (error) {
      if (error.code === "DREAM_RUNNING") toast("the island is already dreaming");
      return;
    }
    this.dreamButton.disabled = true;
    this.dreamButton.textContent = "☾ dreaming...";
    const timer = setInterval(async () => {
      const report = await this.api.dreamLatest().catch(() => null);
      if (!report || report.run_id === before || report.status === "running") return;
      clearInterval(timer);
      this.dreamButton.disabled = false;
      this.dreamButton.textContent = "☾ dream";
      if (report.status === "done") this.onDreamReport(report);
      else toast("the dream broke apart; try again");
    }, 900);
  }

  _newKeeper() {
    const panel = holoPanel({ title: "a new keeper", root: this.root.parentElement, width: "360px" });
    const hint = document.createElement("p");
    hint.textContent = "One keeper, one topic. What should she keep?";
    hint.style.marginBottom = "10px";
    const row = document.createElement("div");
    row.className = "chat-input";
    const input = document.createElement("input");
    input.placeholder = "films, places, my cat...";
    input.setAttribute("aria-label", "topic");
    const go = document.createElement("button");
    go.textContent = "create";
    const submit = async () => {
      const topic = input.value.trim();
      if (!topic) return;
      try {
        const keeper = await this.api.createKeeper(topic);
        toast(`${keeper.name} has her house now`);
        panel.close();
        this.onWorldChanged?.();
      } catch (error) {
        toast(error.code === "KEEPERS_FULL" ? "no free plots on the light side"
          : error.code === "KEEPER_EXISTS" ? "she already exists"
          : "could not create her: " + error.code);
      }
    };
    go.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    row.append(input, go);
    panel.body.append(hint);
    panel.el.append(row);
    input.focus();
  }
}
