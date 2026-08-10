// Overlay for graph mode ("the movie"): the run narrative, a subtle wave
// progress indicator, and Skip / Back buttons that speak over the bus.
// Also exports startConsolidationWatch: the poll-until-done helper used after
// bus "consolidation:started".
//
// Factory only, no module-level side effects. Styles ship in a scoped <style>
// tag with a unique class prefix (keepergx-) so nothing leaks into other UI.

const PREFIX = "keepergx";

const CSS = `
.${PREFIX}-hud {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  font-family: var(--font, system-ui), sans-serif;
  color: #ffd3a1;
  z-index: 5;
}
.${PREFIX}-panel {
  pointer-events: auto;
  margin: 0 auto 22px;
  max-width: 560px;
  padding: 14px 18px;
  background: repeating-linear-gradient(0deg, rgba(255,196,128,.05) 0 1px, rgba(0,0,0,0) 1px 3px),
    rgba(24, 12, 4, 0.82);
  border: 1px solid rgba(255, 166, 64, 0.42);
  border-top: 2px solid #ffb658;
  border-radius: 6px;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 0 20px rgba(255, 150, 40, 0.22), 0 12px 32px rgba(0, 0, 0, 0.55);
  animation: ${PREFIX}-in 260ms cubic-bezier(.34,1.56,.64,1) both;
}
@keyframes ${PREFIX}-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.${PREFIX}-title {
  margin: 0 0 6px;
  font-family: var(--font-display, inherit);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #ffb658;
  text-shadow: 0 0 9px rgba(255, 166, 64, 0.5);
}
.${PREFIX}-narrative {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.5;
  color: #ffd3a1;
  max-height: 30vh;
  overflow-y: auto;
}
.${PREFIX}-progress {
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 166, 64, 0.18);
  overflow: hidden;
  margin-bottom: 12px;
}
.${PREFIX}-progress-fill {
  height: 100%;
  width: 0%;
  border-radius: 2px;
  background: linear-gradient(90deg, #ffb658, #3fe0ff);
  transition: width 0.2s ease-out;
}
.${PREFIX}-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.${PREFIX}-btn {
  pointer-events: auto;
  padding: 6px 16px;
  font-family: var(--font-display, inherit);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #ffb658;
  background: rgba(255, 166, 64, 0.08);
  border: 1px solid rgba(255, 166, 64, 0.55);
  border-radius: 4px;
  cursor: pointer;
  transition: background 130ms ease, box-shadow 130ms ease;
}
.${PREFIX}-btn:hover {
  background: rgba(255, 166, 64, 0.2);
  box-shadow: 0 0 14px rgba(255, 166, 64, 0.5);
}
.${PREFIX}-btn:active { filter: brightness(0.9); }
.${PREFIX}-btn:focus-visible {
  outline: 2px solid #3fe0ff;
  outline-offset: 2px;
}
`;

export function createGraphHud({ root, bus, report = null } = {}) {
  const doc = root.ownerDocument;

  const style = doc.createElement("style");
  style.setAttribute(`data-${PREFIX}`, "");
  style.textContent = CSS;
  (doc.head ?? root).appendChild(style);

  const hud = doc.createElement("div");
  hud.className = `${PREFIX}-hud`;

  const panel = doc.createElement("div");
  panel.className = `${PREFIX}-panel`;

  const title = doc.createElement("h2");
  title.className = `${PREFIX}-title`;
  title.textContent = "The Dreaming";
  panel.appendChild(title);

  const narrative = doc.createElement("p");
  narrative.className = `${PREFIX}-narrative`;
  narrative.textContent =
    report?.narrative ?? "The dreaming left no note this time; watch what it connected.";
  panel.appendChild(narrative);

  const progress = doc.createElement("div");
  progress.className = `${PREFIX}-progress`;
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "assembly progress");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.setAttribute("aria-valuenow", "0");
  const fill = doc.createElement("div");
  fill.className = `${PREFIX}-progress-fill`;
  progress.appendChild(fill);
  panel.appendChild(progress);

  const actions = doc.createElement("div");
  actions.className = `${PREFIX}-actions`;

  const skipBtn = doc.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = `${PREFIX}-btn`;
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", () => bus.emit("graph:skip"));
  actions.appendChild(skipBtn);

  const backBtn = doc.createElement("button");
  backBtn.type = "button";
  backBtn.className = `${PREFIX}-btn`;
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => bus.emit("graph:back"));
  actions.appendChild(backBtn);

  panel.appendChild(actions);
  hud.appendChild(panel);
  root.appendChild(hud);

  function setProgress(t) {
    const pct = Math.round(Math.min(1, Math.max(0, t)) * 100);
    progress.setAttribute("aria-valuenow", String(pct));
    fill.style.width = `${pct}%`;
  }

  const unsubs = [
    bus.on("graph:progress", ({ t } = {}) => setProgress(t ?? 0)),
    bus.on("graph:settled", () => {
      setProgress(1);
      skipBtn.hidden = true;
    }),
  ];

  return {
    element: hud,
    setProgress,
    dispose() {
      for (const off of unsubs) off?.();
      hud.remove();
      style.remove();
    },
  };
}

// --- consolidation polling ----------------------------------------------------
//
// Call after bus "consolidation:started" fires with a run id. Polls
// GET /dreams/{run_id} with backoff until the report settles:
//   done   -> bus "consolidation:finished" {report}
//   failed -> bus "toast" {message, kind: "error"} + "consolidation:failed"
// Returns {stop(), done} where done resolves with the final report (or null
// when stopped / failed).

export function startConsolidationWatch({
  api,
  bus,
  runId,
  intervalMs = 2500,
  maxIntervalMs = 10000,
  backoffFactor = 1.4,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let stopped = false;
  const fetchReport = api.getConsolidation ?? api.consolidation;

  function fail(message, extra) {
    bus.emit("toast", { message, kind: "error" });
    bus.emit("consolidation:failed", { runId, ...extra });
  }

  const done = (async () => {
    let wait = intervalMs;
    for (;;) {
      if (stopped) return null;
      let report;
      try {
        report = await fetchReport.call(api, runId);
      } catch (error) {
        if (stopped) return null;
        fail(`Could not check on the dreaming: ${error?.message ?? "engine unreachable"}`, { error });
        return null;
      }
      if (stopped) return null;
      if (report?.status === "done") {
        bus.emit("consolidation:finished", { report });
        return report;
      }
      if (report?.status === "failed") {
        fail("The dreaming came apart; try again.", { report });
        return null;
      }
      await sleep(wait);
      wait = Math.min(maxIntervalMs, wait * backoffFactor);
    }
  })();

  return {
    stop() {
      stopped = true;
    },
    done,
  };
}
