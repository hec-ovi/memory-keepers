// Chatter scheduler: decides WHICH on-screen keeper speaks and WHEN. Pure logic;
// the scene reacts to a pick by calling api.getChatter(keeperId) and showing the
// bubble via render/speech.js.
//
// Rules:
//  - at most one bubble on screen at a time (no overlap),
//  - a global gap between any two bubbles (CHATTER_GLOBAL_GAP_S),
//  - a per-keeper cooldown (CHATTER_COOLDOWN_S),
//  - never the same keeper twice in a row when someone else is eligible,
//  - randomized jitter so bubbles do not tick like a metronome.

export function createChatter({
  cooldownS = 20,
  globalGapS = 6,
  bubbleS = 4.5,
  jitterS = [1, 6], // extra random wait added after each opportunity
  random = Math.random,
} = {}) {
  const cooldowns = new Map(); // keeperId -> seconds remaining
  let bubbleLeft = 0; // active bubble time remaining
  let gapLeft = 0; // global gap remaining (starts after a bubble begins)
  let waitLeft = jitter(); // current jittered wait before the next attempt
  let lastSpeaker = null;

  function jitter() {
    const [lo, hi] = jitterS;
    return lo + (hi - lo) * random();
  }

  return {
    get speaking() {
      return bubbleLeft > 0 ? lastSpeaker : null;
    },

    // Advance timers and maybe pick a speaker. visibleIds: keepers currently on
    // screen (the scene culls off-screen ones). Returns {keeperId} or null.
    update(dt, visibleIds = []) {
      if (!Number.isFinite(dt) || dt < 0) dt = 0;
      bubbleLeft = Math.max(0, bubbleLeft - dt);
      gapLeft = Math.max(0, gapLeft - dt);
      waitLeft = Math.max(0, waitLeft - dt);
      for (const [id, left] of cooldowns) {
        const next = left - dt;
        if (next <= 0) cooldowns.delete(id);
        else cooldowns.set(id, next);
      }

      if (waitLeft > 0 || bubbleLeft > 0 || gapLeft > 0) return null;
      if (!visibleIds.length) return null;

      let candidates = visibleIds.filter((id) => !cooldowns.has(id));
      if (!candidates.length) {
        waitLeft = jitter();
        return null;
      }
      if (candidates.length > 1) {
        candidates = candidates.filter((id) => id !== lastSpeaker);
      }
      const pick = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];

      lastSpeaker = pick;
      cooldowns.set(pick, cooldownS);
      bubbleLeft = bubbleS;
      gapLeft = bubbleS + globalGapS;
      waitLeft = jitter();
      return { keeperId: pick };
    },

    // The scene may know the real bubble length (text-dependent); let it
    // stretch the no-overlap window.
    extendBubble(seconds) {
      if (Number.isFinite(seconds) && seconds > bubbleLeft) {
        gapLeft += seconds - bubbleLeft;
        bubbleLeft = seconds;
      }
    },

    reset() {
      cooldowns.clear();
      bubbleLeft = 0;
      gapLeft = 0;
      waitLeft = jitter();
      lastSpeaker = null;
    },
  };
}
