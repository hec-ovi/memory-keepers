// Holo comm panel for the selected keeper. The conversation is one framed
// chat block: your rows and hers, her replies typing themselves out in amber
// with their book links attached. While a request is in flight the composer
// pill wears the kit's spinning "thinking" border (holo-thinking).
//
// Layout: the panel is a flex column with the COMPOSER PINNED TO THE BOTTOM.
// ONE input serves the whole conversation (the model routes each send to tell
// or ask via api.say): a pill whose right end merges into the round mic
// button, with the attach (+) button outside the pill; Enter sends. The chat
// scrollback is a framed block at the top. The speaker toggle lives in the
// panel header.
//
// Chat grounding: an ask reply that is grounded in books renders full-width
// clickable book links under the reply (spine-colored bar + full title, glow
// staggered so the first consulted book burns brightest, click opens the
// reader) and emits "memory:used" the moment they appear. An ungrounded reply
// with a follow-up ({grounded: false, followup: true}) renders instead a "she
// does not remember this" hint with the follow-up question and a "Save this
// as a memory" shortcut that pre-fills the Tell tab.
//
// Rest and sleep: the panel header carries a level badge (LV n, amber) and a
// thin rest meter fed from keeper.session {tokens_used, budget, status} (fill
// cyan -> amber -> red). When she is getting tired / needs to dream a status
// line and a "Send to sleep" button appear: it calls api.sleep, emits
// "keeper:sleep", disables the chat inputs, polls api.sleepJob until done, then
// refreshes the keeper record and emits "keeper:rested". A 409 NEEDS_SLEEP from
// a send is caught and rendered as the same send-to-sleep prompt; a 409
// LIBRARY_FULL from tell (her one bookcase is full) renders the same prompt
// with a "her library is full" note: dreaming makes room.
//
// Unconscious keepers can be talked to as well: she listens and answers, but
// keeps no books of what you tell her (a soft hint above the composer says so;
// her books are born from dreaming). A tell reply without a book emits no
// "book:created".
//
// Voice: push-to-talk and spoken replies. Holding the physical T key (outside
// any typing surface) records; the round mic button is the same thing as a
// toggle, click to start, click to stop. Recording runs through getUserMedia +
// MediaRecorder (opus; webm when supported, else ogg; one stream per dialog
// session, released on close), and while it runs everything outside the panel
// is inert (body.ui-recording): no click or Esc can interrupt a live take.
// Stopping sends the clip to api.stt and the transcription goes through the
// exact same send path as a typed message.
// The header speaker button toggles spoken replies: when ON each completed
// reply is fetched from api.tts (monument panel -> "monument", unconscious
// keeper -> "dark", else "light") and played from a Blob object URL (revoked
// after playback); it glows while she speaks. VOICE_UNAVAILABLE or a denied
// microphone toasts once and rests the mic for the session; a TTS failure
// never breaks the dialog.
//
//   const dialog = createDialog({ root, state, bus, api, toasts });
//   dialog.open("dreams"); dialog.close(); dialog.dispose();
//
// Bus wiring:
//   listens "keeper:selected"  ({ keeperId } or a bare id)  -> opens the panel
//   listens "state:loaded"   -> refreshes the open panel's session/level
//                               header cluster from the re-synced state
//   emits   "keeper:join"      { keeperId }                 Join button (closes first)
//   emits   "book:created"   { keeperId, book }           after a tell that wrote a book
//   emits   "book:open"      { keeperId, slug }           consulted book click
//   emits   "memory:used"    { keeperId, slugs }          grounded ask reply lands
//   emits   "keeper:sleep"     { keeperId }                 after api.sleep succeeds
//   emits   "keeper:rested"    { keeperId }                 sleep job polled to done
//   emits   "voice:mic"      { keeperId, on }             recording started/stopped
//   emits   "voice:tts"      { keeperId, on }             speaker toggle (spoken replies)
//   emits   "voice:state"    { keeperId, mode }           voice mode changes
//                            ("idle" | "listening" | "speaking")
//   emits   "ui:open" / "ui:close"  { panel: "dialog" }  panel lifecycle; the
//                            overworld uses them to defer/cancel a deselect
//
// Only the header's X closes the panel: outside clicks and Esc never do, so a
// conversation cannot be lost mid-thought.

import { renderMd } from "./md.js";
import { config as gameConfig } from "../config.js";
import { createHoloPanel, ensureHoloStyles, ensureThinking, injectStyle, makeEl } from "./holo/holo.js";

const STYLE_ID = "mk-dialog-style";
const CSS = `
/* The panel opens at 75% of the viewport so the conversation reads long;
   the native handle (bottom edge) lets the player resize it either way. */
.mk-dialog{position:absolute;top:70px;right:16px;width:min(370px,calc(100vw - 32px));height:75vh;min-height:300px;max-height:calc(100vh - 96px);display:flex;flex-direction:column;overflow:hidden;resize:vertical;z-index:30;}
.mk-dialog .holo-panel__body{flex:1;min-height:0;display:flex;flex-direction:column;}
.mk-dialog-inner{flex:1;min-height:0;display:flex;flex-direction:column;}
.mk-dialog-chips{margin-bottom:8px;}
/* action row at the bottom of the panel, buttons gathered at the right */
.mk-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin:0 0 10px;}
/* scrollback: a framed chat block, newest at the bottom (autoscrolled),
   older rows scroll away behind a always-visible thin scrollbar */
.mk-dialog-hist{flex:1;min-height:96px;overflow-y:scroll;margin-bottom:8px;padding:4px;border:1px solid var(--holo-line,rgba(255,166,64,.42));border-radius:4px;background:rgba(0,0,0,.35);scrollbar-width:thin;scrollbar-color:var(--holo-amber-dim,rgba(255,166,64,.55)) transparent;}
.mk-dialog-hist::-webkit-scrollbar{width:6px;}
.mk-dialog-hist::-webkit-scrollbar-thumb{background:var(--holo-amber-dim,rgba(255,166,64,.55));border-radius:3px;}
/* Bubbles alternate like a common conversation: yours hug the right edge,
   hers the left, neither spanning the full width. */
.mk-dialog-hist{display:flex;flex-direction:column;gap:9px;}
.mk-dialog-hist-row{font-size:.78rem;line-height:1.35;padding:4px 8px;max-width:85%;}
.mk-dialog-hist-row-user{align-self:flex-end;}
.mk-dialog-hist-row-keeper{align-self:flex-start;}
.mk-dialog-hist-row-keeper{color:var(--holo-amber-hi,#ffd9a0);}
/* your own turns: blue-bordered on a darker ground, apart from her amber */
.mk-dialog-hist-row-user{border:1px solid rgba(63,224,255,.55);border-left:3px solid rgba(63,224,255,.8);background:rgba(0,8,14,.6);}
@keyframes mk-dialog-breathe{0%,100%{opacity:.9;}50%{opacity:.35;}}
.mk-dialog-hist-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;}
.mk-dialog-hist-body p:first-child{margin-top:0;}
.mk-dialog-hist-body p:last-child{margin-bottom:0;}

/* composer row: the pill (input + mic) with the attach button outside it */
.mk-dialog-composer{display:flex;align-items:center;gap:6px;margin-top:auto;}
.mk-dialog-io{position:relative;flex:1;min-width:0;display:flex;align-items:center;gap:4px;border:1px solid var(--holo-amber-dim,rgba(255,166,64,.55));border-radius:0 999px 999px 0;background:rgba(10,5,2,.75);padding:3px 3px 3px 14px;}
.mk-dialog-io.holo-thinking{border-radius:0 999px 999px 0;}
.mk-dialog-io.holo-thinking::before,.mk-dialog-io.holo-thinking::after{border-radius:0 999px 999px 0;}
.mk-dialog-field{flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--holo-amber-hi,#ffd9a0);caret-color:var(--holo-cyan,#3fe0ff);font-family:var(--holo-font,inherit);font-size:.92rem;letter-spacing:.02em;padding:8px 0;}
.mk-dialog-field::placeholder{color:rgba(255,182,88,.4);}
.mk-dialog-field:disabled{opacity:.5;}
.mk-dialog-mic{width:38px;height:38px;min-width:38px;border-radius:50%;padding:0;font-size:.95rem;margin:-1px;}
.mk-dialog-mic[aria-pressed="true"]{background:var(--holo-cyan,#3fe0ff);border-color:transparent;color:#03272e;box-shadow:0 0 14px rgba(63,224,255,.6);}
/* header speaker toggle: spoken replies on/off, glows while she speaks */
.mk-dialog-spk{margin-left:auto;width:26px;height:26px;min-width:26px;border-radius:50%;padding:0;font-size:.72rem;}
.mk-dialog-spk[aria-pressed="true"]{background:var(--holo-cyan,#3fe0ff);border-color:transparent;color:#03272e;box-shadow:0 0 10px rgba(63,224,255,.6);}
.mk-dialog-spk--speaking{box-shadow:0 0 14px rgba(63,224,255,.6);animation:mk-dialog-breathe 1.1s ease-in-out infinite;}

/* while the mic records, everything outside the panel is inert */
.ui-recording #app{pointer-events:none!important}
.ui-recording #ui > *:not(.mk-dialog){pointer-events:none!important}

/* the unconscious whisper hint above the composer */
.mk-dialog-whisper{margin:0 0 8px;font-size:.78rem;font-style:italic;opacity:.85;color:var(--holo-cyan,#3fe0ff);}

/* header session cluster: level badge + thin rest meter */
.mk-dialog-sess{display:flex;align-items:center;gap:8px;margin-left:auto;}
.mk-dialog-level{font-size:.66rem;font-weight:700;letter-spacing:.12em;color:var(--holo-amber,#ffb658);border:1px solid var(--holo-amber-dim,rgba(255,166,64,.55));border-radius:3px;padding:1px 6px;text-shadow:0 0 8px rgba(255,166,64,.5);white-space:nowrap;}
.mk-dialog-rest{position:relative;width:64px;height:5px;border:1px solid var(--holo-line,rgba(255,166,64,.42));border-radius:3px;background:rgba(0,0,0,.55);overflow:hidden;}
.mk-dialog-rest-fill{height:100%;width:0;background:var(--holo-cyan,#3fe0ff);transition:width 300ms ease,background 300ms ease;}
.mk-dialog-rest--amber .mk-dialog-rest-fill{background:var(--holo-amber,#ffb658);}
.mk-dialog-rest--red .mk-dialog-rest-fill{background:var(--holo-danger,#ff7a5c);box-shadow:0 0 8px rgba(255,122,92,.85);}

/* sleep prompt row */
.mk-dialog-sleeprow{display:flex;align-items:center;gap:8px;margin:0 0 10px;border:1px dashed var(--holo-line,rgba(255,166,64,.42));border-radius:4px;padding:7px 10px;}
.mk-dialog-sleepnote{flex:1;font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--holo-amber,#ffb658);animation:mk-dialog-breathe 1.7s ease-in-out infinite;}
.mk-dialog-sleeprow--red .mk-dialog-sleepnote{color:var(--holo-danger,#ff7a5c);}

/* consulted books: full-width clickable links under the reply, staggered glow */
.mk-dialog-consulted{display:flex;flex-direction:column;gap:2px;}
.mk-dialog-booklist{display:flex;flex-direction:column;gap:2px;}
.mk-dialog-book{display:flex;align-items:center;gap:6px;width:100%;min-height:24px;padding:2px 4px;background:transparent;border:1px solid transparent;border-radius:3px;color:var(--holo-amber-hi,#ffd9a0);font-size:.72rem;text-align:left;cursor:pointer;animation:mk-dialog-bookglow 1.6s ease-in-out both;}
.mk-dialog-book:hover{border-color:var(--holo-amber-dim,rgba(255,166,64,.55));box-shadow:0 0 12px var(--holo-amber,#ffb658);}
.mk-dialog-book:focus-visible{outline:2px solid var(--holo-cyan,#3fe0ff);outline-offset:1px;}
.mk-dialog-spine{width:6px;height:16px;flex:none;border-radius:1px;border:1px solid rgba(0,0,0,.4);background:var(--mk-book-spine,#8a6a4a);}
.mk-dialog-book--lead .mk-dialog-spine{height:20px;}
.mk-dialog-booktitle{min-width:0;}
@keyframes mk-dialog-bookglow{0%{box-shadow:none;filter:brightness(.85);}35%{box-shadow:0 0 12px var(--holo-amber,#ffb658);filter:brightness(1.6);}100%{box-shadow:0 0 3px rgba(255,182,88,.3);filter:brightness(1);}}
@keyframes mk-dialog-bookglow-lead{0%{box-shadow:none;filter:brightness(.85);}35%{box-shadow:0 0 18px var(--holo-amber,#ffb658);filter:brightness(1.9);}100%{box-shadow:0 0 9px rgba(255,182,88,.75);filter:brightness(1.12);}}
.mk-dialog-book--lead{animation-name:mk-dialog-bookglow-lead;}

/* ungrounded reply: she does not remember */
.mk-dialog-nomem{border:1px dashed var(--holo-cyan-dim,rgba(63,224,255,.35));border-radius:4px;padding:10px 12px;margin:2px 0 8px;}
.mk-dialog-nomem-title{margin:0 0 6px;font-size:.68rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--holo-cyan,#3fe0ff);text-shadow:0 0 8px rgba(63,224,255,.5);}
.mk-dialog-nomem-q{margin:0 0 8px;font-size:.88rem;font-style:italic;color:var(--holo-amber-hi,#ffd9a0);}
`;

// Reply typing: ≤ ~220 ticks at 14 ms so even long replies land within ~3 s.
export function typingStep(length, maxTicks = 220) {
  return Math.max(1, Math.ceil(length / maxTicks));
}

// Sleep-job poll cadence (ms); createDialog({ sleepPollMs }) overrides (tests).
export const SLEEP_POLL_MS = 1500;

// Rest meter state from an Keeper session {tokens_used, budget, status}.
// tone: "cyan" (fresh) -> "amber" (getting tired) -> "red" (needs to dream).
// Pure; tested directly.
export function restTone(session = null) {
  const used = Math.max(0, Number(session?.tokens_used) || 0);
  const budget = Number(session?.budget) || 0;
  const ratio = budget > 0 ? Math.max(0, Math.min(1, used / budget)) : 0;
  const status = session?.status ?? "rested";
  let tone = ratio < 0.55 ? "cyan" : ratio < 0.85 ? "amber" : "red";
  if (status === "needs_sleep") tone = "red";
  else if (status === "unrested" && tone === "cyan") tone = "amber";
  const label =
    status === "needs_sleep" ? "needs to dream" : status === "unrested" ? "getting tired" : "";
  return { ratio, tone, label, status };
}

// Deterministic spine color for the consulted-book bars. Same formula as the
// interior's spineColorFromTags (tags key, FNV-1a, pleasant HSL band) so a
// book's chat bar matches its 3D spine on the shelf; ui/ cannot import
// render/, hence the local copy. Pure; tested directly.
export function bookSpineColor(tags = []) {
  const list = (Array.isArray(tags) ? tags : [tags])
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const key = list.length ? list.join("|") : "untitled";
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = h >>> 0;
  const hue = h % 360;
  const sat = (42 + ((h >>> 9) % 33)) / 100;
  const light = (38 + ((h >>> 17) % 22)) / 100;
  const k = (n) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

export const MONUMENT_ID = gameConfig.monumentId ?? "the-monument";

// Push-to-talk capture formats, in preference order (voice/CONTRACT.md).
const MIME_WEBM = "audio/webm;codecs=opus";
const MIME_OGG = "audio/ogg;codecs=opus";

// A key aimed at a typing surface must never trigger push-to-talk.
function isTypingTarget(t) {
  if (!t) return false;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return true;
  return t.isContentEditable === true || !!t.closest?.("[contenteditable]");
}

export function createDialog({ root, state, bus, api, toasts, ui, sleepPollMs = SLEEP_POLL_MS } = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? globalThis;
  const notify = toasts ?? ui?.toasts ?? null;
  // Kit styles first, host styles second: .mk-dialog positioning must come
  // later in the cascade than the kit's .holo-panel defaults.
  ensureHoloStyles(doc);
  injectStyle(doc, STYLE_ID, CSS);

  let holo = null;
  let currentId = null;
  let onKey = null;
  let onKeyUp = null;
  const offs = [];

  // voice/typing state for the open panel
  let inFlight = false;
  let ttsOn = false;
  let recording = false; // a press (T or the mic button) is active
  let recordSource = null; // "key" | "pointer"
  let recorder = null; // live MediaRecorder once the mic opened
  let micStream = null; // one stream per dialog session, released on close
  let voiceDisabled = false; // VOICE_UNAVAILABLE or mic denial: mic rests for the session
  let ttsToasted = false; // spoken-reply failures toast once per session
  let voiceKind = "light"; // tts voice: "monument" | "dark" | "light"
  let audioEl = null; // the playing spoken reply
  let audioUrl = null; // its object URL, revoked after playback
  let typingActive = false;
  let holdActive = false;
  let typeTimer = null;
  let holdTimer = null;
  let typingRun = null; // { span, text, md } of the reply row typing right now
  let lastVoiceMode = null;
  let histBox = null;
  let keeperName = "";

  // session/sleep state for the open panel
  let session = null; // local copy of keeper.session, patched by 409s and sleep
  let level = 1;
  let libraryFull = false; // 409 LIBRARY_FULL seen; dreaming makes room
  let levelEl = null;
  let meterEl = null;
  let meterFill = null;
  let sleepRow = null;
  let sleepNote = null;
  let sleepBtn = null;
  let chatLocked = false;
  let composer = null; // { form, input, micBtn, attachBtn, sync }
  let spkBtn = null; // header speaker toggle (spoken replies)

  // keepers currently dreaming; polling continues even if the panel closes
  const sleepingIds = new Set();
  let factoryDisposed = false;
  const delay = (ms) => new Promise((r) => win.setTimeout(r, ms));

  const el = makeEl(doc);

  function toastError(message) {
    if (notify) notify.error(message);
    else bus?.emit("toast", { message, kind: "error" });
  }

  function toastInfo(message) {
    if (notify) notify.show(message);
    else bus?.emit("toast", { message });
  }

  function keeperFor(keeperId) {
    if (keeperId === MONUMENT_ID) {
      return {
        id: MONUMENT_ID,
        name: "Memory Keeper",
        topic: "",
        kind: "conscious",
        palette: { primary: "#57e6ff", accent: "#2fb9ff" },
        monument: true,
      };
    }
    return (
      state?.keepers?.find((a) => a.id === keeperId) ?? {
        id: keeperId,
        name: keeperId,
        topic: "",
        kind: "conscious",
        palette: {},
      }
    );
  }

  // --- voice state ------------------------------------------------------------

  function computedVoiceMode() {
    if (typingActive || holdActive) return "speaking";
    if (inFlight || recording) return "listening";
    return "idle";
  }

  function syncVoice() {
    if (!holo) return;
    const mode = computedVoiceMode();
    if (mode === lastVoiceMode) return;
    lastVoiceMode = mode;
    bus?.emit("voice:state", { keeperId: currentId, mode });
    spkBtn?.classList.toggle("mk-dialog-spk--speaking", mode === "speaking" && ttsOn);
  }

  // Stops the typing effect; an interrupted reply row finishes instantly so
  // the chat never keeps a half-typed sentence.
  function cancelTyping() {
    if (typeTimer !== null) win.clearTimeout(typeTimer);
    if (holdTimer !== null) win.clearTimeout(holdTimer);
    typeTimer = null;
    holdTimer = null;
    typingActive = false;
    holdActive = false;
    if (typingRun) {
      const { span, text, md } = typingRun;
      typingRun = null;
      if (md) {
        span.textContent = "";
        renderMd(span, text);
      } else {
        span.textContent = text;
      }
    }
  }

  // Types `text` into a fresh keeper chat row; markdown is swapped in once
  // complete so the final render keeps its formatting. Returns the row's
  // body so extras (book links, hints) can attach under the text.
  function say(text, { md = false } = {}) {
    cancelTyping();
    speakReply(text);
    typingActive = true;
    syncVoice();
    const { span, body } = pushHistory("keeper", "");
    typingRun = { span, text, md };
    const step = typingStep(text.length);
    let idx = 0;
    const tick = () => {
      idx = Math.min(text.length, idx + step);
      span.textContent = text.slice(0, idx);
      if (histBox) histBox.scrollTop = histBox.scrollHeight;
      if (idx >= text.length) {
        typeTimer = null;
        typingRun = null;
        if (md) {
          span.textContent = "";
          renderMd(span, text);
        }
        typingActive = false;
        holdActive = true; // she keeps glowing a beat after the last word
        syncVoice();
        holdTimer = win.setTimeout(() => {
          holdTimer = null;
          holdActive = false;
          syncVoice();
        }, 650);
        return;
      }
      typeTimer = win.setTimeout(tick, 14);
    };
    typeTimer = win.setTimeout(tick, 14);
    return body;
  }

  // One chat row. Only user rows carry a label; the keeper's rows speak
  // through color alone. Returns { row, body, span } so the keeper's reply
  // can type into span and attach extras into body.
  function pushHistory(kind, text) {
    if (!histBox) return { row: null, body: null, span: null };
    const row = el("div", `mk-dialog-hist-row mk-dialog-hist-row-${kind} holo-row`);
    const body = el("div", "mk-dialog-hist-body");
    const span = el("span", null, text);
    body.appendChild(span);
    row.appendChild(body);
    histBox.appendChild(row);
    while (histBox.children.length > 60) histBox.firstChild.remove();
    histBox.scrollTop = histBox.scrollHeight;
    return { row, body, span };
  }

  function setInFlight(on) {
    inFlight = on;
    syncVoice();
  }

  // --- push-to-talk (hold T or hold the mic button) ---------------------------

  // VOICE_UNAVAILABLE or a denied microphone: voice rests for this dialog
  // session; typing keeps working.
  function disableVoice() {
    if (voiceDisabled) return;
    voiceDisabled = true;
    if (composer?.micBtn) composer.micBtn.disabled = true;
    toastInfo("voice is not available here; typing still works");
  }

  async function ensureStream() {
    if (micStream) return micStream;
    const stream = await win.navigator.mediaDevices.getUserMedia({ audio: true });
    if (!holo) {
      // the panel closed while the mic was opening
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    micStream = stream;
    return stream;
  }

  // Press records, release stops; the clip lands in transcribe().
  async function startRecording(source) {
    if (recording || voiceDisabled || chatLocked) return;
    if (!win.MediaRecorder || !win.navigator?.mediaDevices?.getUserMedia) {
      disableVoice();
      return;
    }
    recording = true;
    recordSource = source;
    doc.body?.classList.add("ui-recording");
    composer?.micBtn?.setAttribute("aria-pressed", "true");
    bus?.emit("voice:mic", { keeperId: currentId, on: true });
    syncVoice();
    let stream;
    try {
      stream = await ensureStream();
    } catch {
      stopRecording(false);
      if (holo) disableVoice();
      return;
    }
    if (!stream || !recording) return; // closed, or released while the mic opened
    const mime = win.MediaRecorder.isTypeSupported?.(MIME_WEBM) ? MIME_WEBM : MIME_OGG;
    const chunks = [];
    const rec = new win.MediaRecorder(stream, { mimeType: mime });
    rec.addEventListener("dataavailable", (e) => {
      if (e.data?.size) chunks.push(e.data);
    });
    rec.addEventListener("stop", () => {
      if (!rec.discarded) transcribe(new Blob(chunks, { type: mime }));
    });
    rec.start();
    recorder = rec;
  }

  function stopRecording(send = true) {
    if (!recording) return;
    recording = false;
    recordSource = null;
    doc.body?.classList.remove("ui-recording");
    composer?.micBtn?.setAttribute("aria-pressed", "false");
    bus?.emit("voice:mic", { keeperId: currentId, on: false });
    syncVoice();
    const rec = recorder;
    recorder = null;
    if (rec && rec.state !== "inactive") {
      rec.discarded = !send;
      rec.stop();
    }
  }

  function releaseStream() {
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
  }

  // The released clip -> api.stt -> the composer -> the exact same send path
  // as a typed message.
  async function transcribe(blob) {
    if (!composer) return;
    const { form, input } = composer;
    if (!blob?.size) {
      toastInfo("no words came through; try again");
      return;
    }
    ensureThinking(form, true);
    let text;
    try {
      const res = await api.stt(blob);
      text = (res?.text ?? "").trim();
    } catch (err) {
      ensureThinking(form, false);
      if (err?.code === "VOICE_UNAVAILABLE") disableVoice();
      else toastError(err?.message || "the words were lost on the way");
      return;
    }
    ensureThinking(form, false);
    if (composer?.form !== form || chatLocked) return; // panel changed meanwhile
    if (!text) {
      toastInfo("no words came through; try again");
      return;
    }
    input.value = text;
    composer.sync();
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  // --- spoken replies ---------------------------------------------------------

  function stopPlayback() {
    if (audioEl) {
      audioEl.pause();
      audioEl = null;
    }
    if (audioUrl) {
      (win.URL ?? URL).revokeObjectURL(audioUrl);
      audioUrl = null;
    }
  }

  // With the speaker toggle on, a completed reply is fetched from api.tts and
  // played; failures fall back to the written reply (toast once per session)
  // and never break the dialog.
  async function speakReply(text) {
    if (!ttsOn || !text) return;
    const forId = currentId;
    try {
      const blob = await api.tts(text, voiceKind);
      if (!ttsOn || currentId !== forId) return; // toggled off or panel changed
      stopPlayback();
      const urlApi = win.URL ?? URL;
      const url = urlApi.createObjectURL(blob);
      const audio = new win.Audio(url);
      audioEl = audio;
      audioUrl = url;
      const cleanup = () => {
        urlApi.revokeObjectURL(url);
        if (audioEl === audio) {
          audioEl = null;
          audioUrl = null;
        }
      };
      audio.addEventListener("ended", cleanup);
      audio.addEventListener("error", cleanup);
      audio.play()?.catch?.(cleanup);
    } catch {
      if (!ttsToasted) {
        ttsToasted = true;
        toastInfo("her voice could not reach you; her words stay written");
      }
    }
  }

  // --- rest / sleep ----------------------------------------------------------

  function setChatDisabled(locked) {
    chatLocked = locked;
    composer?.sync();
  }

  // Header badge + meter + the send-to-sleep prompt reflect the local session.
  function renderSession() {
    const info = restTone(session);
    if (levelEl) levelEl.textContent = `LV ${level}`;
    if (meterEl && meterFill) {
      const pct = Math.round(info.ratio * 100);
      meterFill.style.width = `${pct}%`;
      meterEl.className = `mk-dialog-rest mk-dialog-rest--${info.tone}`;
      meterEl.setAttribute("aria-valuenow", String(pct));
    }
    const dreaming = sleepingIds.has(currentId);
    const needs = info.status === "unrested" || info.status === "needs_sleep";
    if (sleepRow) {
      sleepRow.style.display = dreaming || needs || libraryFull ? "" : "none";
      sleepRow.classList.toggle(
        "mk-dialog-sleeprow--red",
        info.status === "needs_sleep" || libraryFull,
      );
    }
    if (sleepNote) {
      sleepNote.textContent = dreaming
        ? "dreaming..."
        : libraryFull
          ? "her library is full. she needs to dream to make room"
          : info.status === "needs_sleep"
            ? "she needs to dream"
            : info.status === "unrested"
              ? "she is getting tired"
              : "";
    }
    if (sleepBtn) sleepBtn.disabled = dreaming;
    setChatDisabled(dreaming);
  }

  // A 409 NEEDS_SLEEP from a send lands here: same prompt as a filling meter.
  function showNeedsSleep() {
    session = { ...(session ?? {}), status: "needs_sleep" };
    renderSession();
  }

  // A 409 LIBRARY_FULL from tell: her one bookcase holds no more books until
  // she dreams (pruning and merging makes room). Same shortcut, warmer note.
  function showLibraryFull() {
    libraryFull = true;
    renderSession();
  }

  // The full sleep lifecycle. Runs at factory scope so polling survives the
  // panel closing; the header/inputs are only touched when the panel still
  // shows this keeper.
  async function runSleep(keeperId) {
    try {
      const res = await api.sleep(keeperId);
      bus?.emit("keeper:sleep", { keeperId });
      const jobId = res?.job_id;
      let status = res?.status ?? "running";
      while (jobId && status !== "done" && status !== "failed" && !factoryDisposed) {
        await delay(sleepPollMs);
        const job = await api.sleepJob(keeperId, jobId);
        status = job?.status ?? "running";
      }
      if (factoryDisposed) return;
      if (status === "failed") throw new Error("the dreaming failed");
      // Refresh the keeper record (session cleared, level may have grown).
      let fresh = null;
      try {
        fresh = await api.getKeeper(keeperId);
      } catch {
        /* state:loaded after keeper:rested re-syncs anyway */
      }
      const rec = state?.keepers?.find((a) => a.id === keeperId);
      if (rec && fresh) Object.assign(rec, fresh);
      sleepingIds.delete(keeperId);
      if (currentId === keeperId) {
        session = fresh?.session ? { ...fresh.session } : { ...(session ?? {}), status: "rested", tokens_used: 0 };
        if (Number.isFinite(fresh?.level)) level = fresh.level;
        libraryFull = false; // dreaming pruned and merged: room again
        renderSession();
      }
      bus?.emit("keeper:rested", { keeperId });
    } catch (err) {
      sleepingIds.delete(keeperId);
      if (currentId === keeperId) renderSession();
      toastError(err?.message || "she could not fall asleep");
    }
  }

  // --- panel ------------------------------------------------------------------

  function close() {
    if (!holo) return;
    stopRecording(false);
    releaseStream();
    stopPlayback();
    if (onKey) doc.removeEventListener("keydown", onKey, true);
    if (onKeyUp) doc.removeEventListener("keyup", onKeyUp, true);
    onKey = null;
    onKeyUp = null;
    cancelTyping();
    holo.close();
    holo = null;
    currentId = null;
    lastVoiceMode = null;
    inFlight = false;
    ttsOn = false;
    voiceDisabled = false;
    ttsToasted = false;
    voiceKind = "light";
    chatLocked = false;
    session = null;
    libraryFull = false;
    histBox = null;
    levelEl = meterEl = meterFill = sleepRow = sleepNote = sleepBtn = null;
    composer = null;
    spkBtn = null;
    bus?.emit("ui:close", { panel: "dialog" });
  }

  // "Save this as a memory": pre-fill the input with keep-this wording so the
  // router reads it as a tell.
  function prefillMemory(text) {
    if (!composer) return;
    composer.input.value = `Remember this: ${text}`;
    composer.sync();
    composer.input.focus();
  }

  // Grounded ask reply: clickable book links attached under the reply text
  // inside its chat row, one spine-colored bar + full title per source, glow
  // staggered (lead book strongest). Ungrounded + followup: the "she does not
  // remember this" hint attaches instead (her follow-up is the typed text).
  function renderAskResult(keeper, res, question, replyBody) {
    if (!replyBody) return;
    if (res?.grounded === false && res?.followup === true) {
      const hint = el("div", "mk-dialog-nomem");
      hint.appendChild(el("p", "mk-dialog-nomem-title", "she does not remember this"));
      if (keeper.kind !== "unconscious") {
        const save = el("button", "holo-btn", "Save this as a memory");
        save.type = "button";
        save.addEventListener("click", () => prefillMemory(question));
        hint.appendChild(save);
      }
      replyBody.appendChild(hint);
      return;
    }
    const sources = res?.sources ?? [];
    if (!sources.length) return;

    const box = el("div", "mk-dialog-consulted");
    box.setAttribute("aria-label", "consulted books");
    const list = el("div", "mk-dialog-booklist");
    sources.forEach((source, i) => {
      const row = el("button", `mk-dialog-book${i === 0 ? " mk-dialog-book--lead" : ""}`);
      row.type = "button";
      const title = source.title || source.slug;
      row.title = title;
      row.setAttribute("aria-label", title);
      row.style.animationDelay = `${i * 220}ms`;
      const spine = el("span", "mk-dialog-spine");
      spine.style.setProperty("--mk-book-spine", bookSpineColor(source.tags));
      row.append(spine, el("span", "mk-dialog-booktitle", title));
      row.addEventListener("click", () => {
        bus?.emit("book:open", { keeperId: keeper.id, slug: source.slug });
      });
      list.appendChild(row);
    });

    box.appendChild(list);
    replyBody.appendChild(box);
    if (histBox) histBox.scrollTop = histBox.scrollHeight;
    bus?.emit("memory:used", { keeperId: keeper.id, slugs: sources.map((s) => s.slug) });
  }

  // One pill input for the whole conversation, its right end merging into the
  // round mic button; the attach (+) button sits outside the pill. Enter sends
  // (native form submission); the model routes each send to tell or ask.
  function buildComposer(keeper) {
    const row = el("div", "mk-dialog-composer");
    const form = doc.createElement("form");
    form.className = "mk-dialog-io";

    const input = doc.createElement("input");
    input.type = "text";
    input.className = "mk-dialog-field";

    // Attach: a .md/.txt file whose content is kept as a memory.
    const fileInput = doc.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".md,.txt,text/markdown,text/plain";
    fileInput.style.display = "none";
    fileInput.setAttribute("aria-hidden", "true");
    const attachBtn = el("button", "holo-btn mk-dialog-mic mk-dialog-attach");
    attachBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z"/>' +
      '<path d="M14 3v4.5h4.5"/><path d="M12 11v6M9 14h6"/></svg>';
    attachBtn.type = "button";
    attachBtn.setAttribute("aria-label", "attach a memory file");
    attachBtn.addEventListener("click", () => fileInput.click());
    const readFileText = (file) =>
      new Promise((resolve, reject) => {
        const reader = new (win.FileReader ?? FileReader)();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      const body = (await readFileText(file)).trim();
      if (!body) {
        toastInfo("that file is empty");
        return;
      }
      send(`Keep this memory from my file "${file.name}":\n\n${body}`,
           { label: `[file] ${file.name}` });
    });

    // The hold-T twin as a toggle: click starts the same recording, click stops.
    const micBtn = el("button", "holo-btn mk-dialog-mic", "🎙");
    micBtn.type = "button";
    micBtn.setAttribute("aria-label", "toggle talking");
    micBtn.setAttribute("aria-pressed", "false");
    micBtn.addEventListener("click", () => {
      if (recording) stopRecording();
      else startRecording("pointer");
    });

    form.append(input, micBtn);
    row.append(form, fileInput, attachBtn);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    });

    let sending = false;

    const sync = () => {
      input.disabled = chatLocked;
    };
    input.addEventListener("input", sync);

    const who = keeper.name || keeper.id;
    input.setAttribute("aria-label", `speak to ${who}`);
    input.placeholder = keeper.monument
      ? "ask across every shelf, or ask for a new keeper..."
      : "tell her a memory, or ask her anything...";

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      send(input.value.trim());
    });

    async function send(text, { label } = {}) {
      if (!text || sending || chatLocked) return;
      sending = true;
      sync();
      // The user's row lands in the chat the moment it is sent, not when the
      // reply arrives, and the input empties right away; a failed send puts
      // the text back so nothing typed is ever lost.
      pushHistory("user", label ?? text);
      input.value = "";
      setInFlight(true);
      ensureThinking(form, true);
      // A reply belongs to the panel that asked: if the panel closed or
      // another keeper's opened while the model thought, the late reply is
      // dropped from the UI (world events still fire, and keeper replies are
      // in her session, so reopening her replays them).
      const stale = () => composer?.form !== form;
      try {
        if (keeper.monument) {
          const res = await api.monument(text);
          if (res?.created_keeper) {
            bus?.emit("keeper:created", res.created_keeper);
          }
          if (stale()) return;
          setInFlight(false);
          ensureThinking(form, false);
          say(res?.reply ?? "...", { md: true });
        } else {
          const res = await api.say(keeper.id, text);
          // Unconscious tells are conversational: she listens, no book is
          // written, so there is nothing to count or announce.
          if (res?.kind !== "ask" && res?.book) {
            const rec = state?.keepers?.find((a) => a.id === keeper.id);
            if (rec) rec.book_count = (rec.book_count ?? 0) + 1;
            bus?.emit("book:created", { keeperId: keeper.id, book: res.book });
          }
          if (stale()) return;
          setInFlight(false);
          ensureThinking(form, false);
          if (res?.kind === "ask") {
            const replyBody = say(res?.answer ?? "", { md: true });
            renderAskResult(keeper, res, text, replyBody);
          } else {
            say(res?.reply ?? "...", { md: true });
          }
          if (res?.session) {
            session = { ...res.session };
            renderSession();
          }
        }
      } catch (err) {
        if (stale()) return;
        setInFlight(false);
        ensureThinking(form, false);
        if (!input.value) input.value = text; // give the words back to retry
        if (err?.code === "NEEDS_SLEEP") showNeedsSleep();
        else if (err?.code === "LIBRARY_FULL") showLibraryFull();
        else if (keeper.monument) toastError(err?.message || "the island did not answer");
        else toastError(err?.message || "she could not answer that");
      } finally {
        sending = false;
        if (!stale()) sync();
      }
    }

    composer = { form, input, micBtn, attachBtn, sync };
    sync();
    return row;
  }

  function open(keeperId) {
    if (!keeperId) return;
    if (holo && currentId === keeperId) return;
    close();
    const keeper = keeperFor(keeperId);
    const isMonument = keeper.monument === true;
    levelEl = meterEl = meterFill = null; // rebuilt per panel; absent for the main keeper
    currentId = keeperId;
    keeperName = keeper.name || keeper.id;
    session = keeper.session ? { ...keeper.session } : null;
    level = Number.isFinite(keeper.level) ? keeper.level : 1;
    libraryFull = false;
    voiceKind = isMonument ? "monument" : keeper.kind === "unconscious" ? "dark" : "light";

    const content = el("div", "mk-dialog-inner");

    // Topic chip only when the keeper's name does not already say it.
    if (keeper.topic && !keeperName.toLowerCase().includes(String(keeper.topic).toLowerCase())) {
      const chips = el("div", "mk-dialog-chips");
      chips.appendChild(el("span", "holo-chip chip", keeper.topic));
      content.appendChild(chips);
    }

    // Scrollback: recent exchanges, small, above the visualizer; the column
    // is bottom-anchored so it grows upward.
    histBox = el("div", "mk-dialog-hist holo-list");
    histBox.setAttribute("aria-label", "recent exchanges");
    content.appendChild(histBox);

    // Persistent history: her session's turn log replays as chat rows the
    // moment the panel opens (instantly, no typing). The same turns are what
    // sleep binds into books and dreaming links across, so the conversation
    // and the consolidation read from one record. The main keeper holds no
    // session, so she has nothing to replay.
    if (!isMonument) {
      api
        ?.getChat?.(keeper.id)
        .then((res) => {
          if (!histBox || currentId !== keeper.id) return;
          for (const turn of res?.turns ?? []) {
            if (!turn?.text) continue;
            const { span } = pushHistory(turn.role === "user" ? "user" : "keeper",
                                         turn.role === "user" ? turn.text : "");
            if (turn.role !== "user" && span) renderMd(span, turn.text);
          }
          histBox.scrollTop = histBox.scrollHeight;
        })
        .catch(() => {});
    }

    // Primary action: join her, in the right-aligned row at the bottom.
    // Closes the panel; the overworld walks her home with the camera
    // following and fires "house:enter" on arrival. The main keeper has no
    // house to join, and inside her own house the player is already with
    // her, so no button either.
    const insideHers = state?.mode === `interior:${keeper.id}`;
    if (!isMonument && !insideHers) {
      const actions = el("div", "mk-dialog-actions");
      const joinBtn = el("button", "holo-btn holo-btn--primary mk-dialog-join", "Join instance");
      joinBtn.type = "button";
      joinBtn.addEventListener("click", () => {
        const id = keeper.id;
        close();
        bus?.emit("keeper:join", { keeperId: id });
      });
      actions.appendChild(joinBtn);
      content.appendChild(actions);
    }


    // Sleep prompt: status line + Send to sleep, shown when she tires (or her
    // library is full), right above the composer.
    sleepRow = el("div", "mk-dialog-sleeprow");
    sleepRow.style.display = "none";
    sleepNote = el("span", "mk-dialog-sleepnote", "");
    sleepNote.setAttribute("role", "status");
    sleepBtn = el("button", "holo-btn mk-dialog-sleep", "Send to sleep");
    sleepBtn.type = "button";
    sleepBtn.addEventListener("click", () => {
      const id = keeper.id;
      if (sleepingIds.has(id)) return;
      sleepingIds.add(id);
      renderSession(); // disables the chat inputs, shows "dreaming..."
      runSleep(id);
    });
    sleepRow.append(sleepNote, sleepBtn);
    content.appendChild(sleepRow);

    // Unconscious keepers listen but keep no books of what you tell them.
    if (keeper.kind === "unconscious") {
      content.appendChild(el(
        "p",
        "mk-dialog-whisper",
        "she listens, but keeps no books of what you tell her. her books are born from dreaming.",
      ));
    }

    // The composer, pinned to the bottom of the panel.
    content.appendChild(buildComposer(keeper));

    holo = createHoloPanel({
      title: keeper.name || keeper.id,
      content,
      size: null, // .mk-dialog owns the footprint
      onClose: close,
      className: "mk-dialog",
    });
    holo.el.setAttribute("aria-label", `talk to ${keeper.name || keeper.id}`);
    const accent = keeper.palette?.accent || keeper.palette?.primary || "#ffb658";
    holo.el.style.setProperty("--mk-dialog-accent", accent);
    holo.el.querySelector(".holo-close")?.setAttribute("aria-label", "close talk panel");

    // Header session cluster: LV badge + thin rest meter, before the ✕.
    // The main keeper holds no session: keepers hold the memory.
    const head = isMonument ? null : holo.el.querySelector(".holo-panel__head");
    if (head) {
      const sess = el("div", "mk-dialog-sess");
      levelEl = el("span", "mk-dialog-level", `LV ${level}`);
      levelEl.setAttribute("aria-label", "keeper level");
      meterEl = el("div", "mk-dialog-rest");
      meterEl.setAttribute("role", "progressbar");
      meterEl.setAttribute("aria-label", "rest meter");
      meterEl.setAttribute("aria-valuemin", "0");
      meterEl.setAttribute("aria-valuemax", "100");
      meterFill = el("div", "mk-dialog-rest-fill");
      meterEl.appendChild(meterFill);
      sess.append(levelEl, meterEl);
      head.insertBefore(sess, head.querySelector(".holo-close"));
    }

    // Header speaker toggle: spoken replies on/off, right before the ✕.
    const headEl = holo.el.querySelector(".holo-panel__head");
    if (headEl) {
      spkBtn = el("button", "holo-btn mk-dialog-spk", "🔊");
      spkBtn.type = "button";
      spkBtn.setAttribute("aria-label", "toggle voice replies");
      spkBtn.setAttribute("aria-pressed", "false");
      const kidForTts = keeper.id;
      spkBtn.addEventListener("click", () => {
        ttsOn = !ttsOn;
        if (!ttsOn) stopPlayback();
        spkBtn.setAttribute("aria-pressed", String(ttsOn));
        spkBtn.classList.toggle("mk-dialog-spk--speaking", false);
        bus?.emit("voice:tts", { keeperId: kidForTts, on: ttsOn });
      });
      headEl.insertBefore(spkBtn, headEl.querySelector(".holo-close"));
    }
    renderSession();

    onKey = (e) => {
      if (e.key === "Escape" && recording) {
        // a live take blocks everything, Esc included
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      // Hold T: push-to-talk, only while this panel is open and only when the
      // key is not aimed at a typing surface or riding a modifier combo.
      if (
        (e.key === "t" || e.key === "T") &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !isTypingTarget(e.target)
      ) {
        startRecording("key");
      }
    };
    onKeyUp = (e) => {
      if ((e.key === "t" || e.key === "T") && recordSource === "key") stopRecording();
    };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("keyup", onKeyUp, true);

    root.appendChild(holo.el);
    lastVoiceMode = "idle";
    bus?.emit("ui:open", { panel: "dialog", keeperId: keeper.id });
  }

  offs.push(bus?.on?.("keeper:selected", (p) => open(typeof p === "string" ? p : p?.keeperId)) ?? (() => {}));

  // Clicking elsewhere in the overworld may clear her ring in the scene, but
  // the talk panel stays: only its X closes it (see the header comment).
  // Leaving an instance back to the island is the exception: the panel
  // belonged to that room and closes with it.
  offs.push(
    bus?.on?.("mode:changed", ({ mode, prev } = {}) => {
      if (holo && String(prev ?? "").startsWith("interior:") && mode === "overworld") close();
    }) ?? (() => {}),
  );

  // The header cluster (LV badge, rest meter, sleep prompt) tracks server
  // truth: every state re-sync refreshes the open panel's local session copy
  // (tell/ask/409 keep it fresh in-panel, but sleep can also be caused
  // elsewhere; without this the row can go stale and hide the Sleep button).
  offs.push(
    bus?.on?.("state:loaded", () => {
      if (!holo || !currentId) return;
      const fresh = state?.keepers?.find((a) => a.id === currentId);
      if (!fresh) return;
      if (fresh.session) session = { ...fresh.session };
      if (Number.isFinite(fresh.level)) level = fresh.level;
      renderSession();
    }) ?? (() => {}),
  );

  return {
    open,
    close,
    isOpen: () => holo !== null,
    dispose() {
      factoryDisposed = true;
      close();
      for (const off of offs) off();
    },
  };
}
