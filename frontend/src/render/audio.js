// Tiny procedural WebAudio blips. No asset files: every sound is an oscillator
// with a short gain envelope. Factory per the module contract, no module-level
// side effects:
//
//   const audio = createAudio({ bus, target });   // target defaults to globalThis
//   audio.play("select");                          // scenes/hud may call directly
//   audio.play("wave", { index: 3 });
//   audio.dispose();
//
// Autoplay-policy safe: the AudioContext is only created after the first user
// gesture (pointerdown/keydown/touchstart on `target`); blips requested before
// that are silently dropped.
//
// Bus wiring (all optional; direct play() works without a bus):
//   listens "keeper:selected"    -> "select"   blip
//   listens "book:created"     -> "reply"    blip (a tell came back with a book)
//   listens "book:open"        -> "book"     blip
//   listens "graph:wave"       -> "wave"     pulse (consolidation movie landing)
//   listens "district:changed" -> "district" ambience shift: a low descending
//                                 pad when the camera crosses into the night
//                                 quarter, a soft rising one coming back to
//                                 the day village
//   listens "ui:open"          -> "panel"      holo panel materialize chirp
//   listens "ui:close"         -> "panelClose" holo panel collapse chirp
//   listens "howto:open" / "create_keeper:open" -> "panel" (modals opening)
//   listens "reader:closed"    -> "panelClose"
//   listens "voice:state"      -> {mode}     comm-panel visualizer blips
//                                 (listening ping / speaking double tone)
//   listens "voice:mic"        -> {on}       mic toggle click
//   listens "audio:mute"       -> {muted}    gate for everything above

const GESTURES = ["pointerdown", "keydown", "touchstart"];

// name -> tone spec(s). from/to in Hz, duration in seconds, peak is gain.
export const BLIPS = {
  select: [{ type: "triangle", from: 660, to: 880, duration: 0.09, peak: 0.05 }],
  reply: [
    { type: "sine", from: 520, to: 660, duration: 0.11, peak: 0.05 },
    { type: "sine", from: 660, to: 840, duration: 0.12, peak: 0.05, delay: 0.09 },
  ],
  book: [{ type: "triangle", from: 300, to: 210, duration: 0.16, peak: 0.05 }],
  wave: ({ index = 0 } = {}) => [
    { type: "sine", from: 280 + 36 * (index % 8), to: 180, duration: 0.3, peak: 0.07 },
  ],
  // holo panel materialize / collapse (ui/holo kit surfaces)
  panel: [
    { type: "triangle", from: 520, to: 980, duration: 0.1, peak: 0.04 },
    { type: "sine", from: 980, to: 1400, duration: 0.08, peak: 0.028, delay: 0.07 },
  ],
  panelClose: [{ type: "triangle", from: 820, to: 360, duration: 0.12, peak: 0.035 }],
  // comm-panel voice states: listening ping up, speaking soft double tone
  voice: ({ mode = "idle" } = {}) =>
    mode === "listening"
      ? [{ type: "sine", from: 640, to: 1180, duration: 0.14, peak: 0.035 }]
      : mode === "speaking"
        ? [
            { type: "sine", from: 420, to: 560, duration: 0.12, peak: 0.04 },
            { type: "sine", from: 560, to: 700, duration: 0.1, peak: 0.03, delay: 0.09 },
          ]
        : [],
  mic: ({ on = true } = {}) =>
    on
      ? [{ type: "sine", from: 880, to: 1320, duration: 0.09, peak: 0.045 }]
      : [{ type: "sine", from: 1320, to: 660, duration: 0.09, peak: 0.04 }],
  district: ({ district = "night" } = {}) =>
    district === "night"
      ? [
          { type: "sine", from: 300, to: 96, duration: 0.9, peak: 0.045 },
          { type: "sine", from: 452, to: 144, duration: 0.9, peak: 0.026, delay: 0.06 },
        ]
      : [
          { type: "sine", from: 120, to: 340, duration: 0.8, peak: 0.04 },
          { type: "triangle", from: 240, to: 500, duration: 0.7, peak: 0.02, delay: 0.08 },
        ],
};

export function createAudio({ bus = null, target = globalThis } = {}) {
  let ctx = null;
  let muted = false;
  let unlocked = false;
  let disposed = false;
  const offs = [];

  function unlock() {
    unlocked = true;
    for (const ev of GESTURES) target.removeEventListener?.(ev, unlock);
    ensureContext();
  }
  for (const ev of GESTURES) target.addEventListener?.(ev, unlock, { passive: true });

  function ensureContext() {
    if (!unlocked || disposed) return null;
    if (!ctx) {
      const AC = target.AudioContext ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
      } catch {
        return null;
      }
    }
    if (ctx.state === "suspended") ctx.resume?.()?.catch?.(() => {});
    return ctx;
  }

  function tone({ type = "sine", from = 440, to = null, duration = 0.15, peak = 0.06, delay = 0 }) {
    const c = ensureContext();
    if (!c) return;
    try {
      const t0 = c.currentTime + delay;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t0);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + duration);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.05);
    } catch {
      /* audio is decoration; never let it break the game */
    }
  }

  function play(name, opts) {
    if (muted || disposed) return;
    const spec = BLIPS[name];
    if (!spec) return;
    const tones = typeof spec === "function" ? spec(opts) : spec;
    for (const t of tones) tone(t);
  }

  if (bus) {
    const on = (event, fn) => offs.push(bus.on(event, fn));
    on("audio:mute", (p) => {
      muted = typeof p === "object" && p !== null ? !!p.muted : !!p;
    });
    on("keeper:selected", () => play("select"));
    on("book:created", () => play("reply"));
    on("book:open", () => play("book"));
    on("graph:wave", (p) => play("wave", { index: p?.index ?? 0 }));
    on("ui:open", () => play("panel"));
    on("ui:close", () => play("panelClose"));
    on("howto:open", () => play("panel"));
    on("create_keeper:open", () => play("panel"));
    on("reader:closed", () => play("panelClose"));
    on("voice:state", (p) => play("voice", { mode: p?.mode ?? "idle" }));
    on("voice:mic", (p) => play("mic", { on: !!p?.on }));
    on("district:changed", (p) =>
      play("district", { district: p?.district === "night" ? "night" : "day" }),
    );
  }

  return {
    play,
    isMuted: () => muted,
    setMuted(value) {
      muted = !!value;
    },
    get unlocked() {
      return unlocked;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const ev of GESTURES) target.removeEventListener?.(ev, unlock);
      for (const off of offs) off();
      try {
        ctx?.close?.();
      } catch {
        /* ignore */
      }
      ctx = null;
    },
  };
}
