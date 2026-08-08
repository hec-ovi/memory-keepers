// src/render/audio.js: procedural blips, gesture unlock, mute wiring.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAudio, BLIPS } from "../src/render/audio.js";
import { createBus } from "../src/bus.js";

// Minimal WebAudio double: records oscillators so tests can count blips.
class FakeAudioContext {
  static instances = [];
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = { name: "destination" };
    this.oscillators = [];
    this.closed = false;
    FakeAudioContext.instances.push(this);
  }
  createOscillator() {
    const osc = {
      type: "",
      started: false,
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (node) => node,
      start() {
        osc.started = true;
      },
      stop() {},
    };
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (node) => node,
    };
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

function gesture() {
  window.dispatchEvent(new Event("pointerdown"));
}

describe("createAudio", () => {
  let audio;
  let bus;

  beforeEach(() => {
    FakeAudioContext.instances = [];
    window.AudioContext = FakeAudioContext;
    bus = createBus();
    audio = createAudio({ bus, target: window });
  });

  afterEach(() => {
    audio.dispose();
    delete window.AudioContext;
  });

  it("creates no AudioContext before the first user gesture (autoplay safe)", () => {
    audio.play("select");
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(audio.unlocked).toBe(false);
  });

  it("unlocks on a user gesture, then plays oscillators", () => {
    gesture();
    expect(audio.unlocked).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    audio.play("select");
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.oscillators[0].started).toBe(true);
  });

  it("plays blips from bus events: select, reply, book, wave, district", () => {
    gesture();
    const ctx = FakeAudioContext.instances[0];
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(ctx.oscillators).toHaveLength(1);
    bus.emit("book:created", { keeperId: "dreams", book: { slug: "x" } });
    expect(ctx.oscillators).toHaveLength(3); // reply is a two-tone chirp
    bus.emit("book:open", { keeperId: "dreams", slug: "x" });
    expect(ctx.oscillators).toHaveLength(4);
    bus.emit("graph:wave", { index: 2 });
    expect(ctx.oscillators).toHaveLength(5);
    bus.emit("district:changed", { district: "night" });
    expect(ctx.oscillators).toHaveLength(7); // the ambience shift is a two-tone pad
    bus.emit("district:changed", { district: "day" });
    expect(ctx.oscillators).toHaveLength(9);
  });

  it("plays holo panel blips: ui:open/ui:close, modal opens, reader close", () => {
    gesture();
    const ctx = FakeAudioContext.instances[0];
    bus.emit("ui:open", { panel: "dialog" });
    expect(ctx.oscillators).toHaveLength(2); // materialize is a two-tone chirp
    bus.emit("ui:close", { panel: "dialog" });
    expect(ctx.oscillators).toHaveLength(3);
    bus.emit("howto:open");
    expect(ctx.oscillators).toHaveLength(5);
    bus.emit("create_keeper:open");
    expect(ctx.oscillators).toHaveLength(7);
    bus.emit("reader:closed");
    expect(ctx.oscillators).toHaveLength(8);
  });

  it("plays voice-state blips: listening ping, speaking double tone, idle silent", () => {
    gesture();
    const ctx = FakeAudioContext.instances[0];
    bus.emit("voice:state", { mode: "listening" });
    expect(ctx.oscillators).toHaveLength(1);
    bus.emit("voice:state", { mode: "speaking" });
    expect(ctx.oscillators).toHaveLength(3); // double tone
    bus.emit("voice:state", { mode: "idle" });
    expect(ctx.oscillators).toHaveLength(3); // idle adds nothing
    expect(BLIPS.voice({ mode: "idle" })).toEqual([]);
  });

  it("mic toggle blips rise on, fall off", () => {
    gesture();
    const ctx = FakeAudioContext.instances[0];
    bus.emit("voice:mic", { keeperId: "dreams", on: true });
    bus.emit("voice:mic", { keeperId: "dreams", on: false });
    expect(ctx.oscillators).toHaveLength(2);
    const [onTone] = BLIPS.mic({ on: true });
    const [offTone] = BLIPS.mic({ on: false });
    expect(onTone.to).toBeGreaterThan(onTone.from); // rising
    expect(offTone.to).toBeLessThan(offTone.from); // falling
  });

  it("district ambience differs by direction: night descends, day rises", () => {
    const night = BLIPS.district({ district: "night" });
    const day = BLIPS.district({ district: "day" });
    for (const t of night) expect(t.to).toBeLessThan(t.from); // falling pads
    for (const t of day) expect(t.to).toBeGreaterThan(t.from); // rising pads
  });

  it("mutes and unmutes via bus audio:mute", () => {
    gesture();
    const ctx = FakeAudioContext.instances[0];
    bus.emit("audio:mute", { muted: true });
    bus.emit("keeper:selected", { keeperId: "dreams" });
    audio.play("book");
    expect(ctx.oscillators).toHaveLength(0);
    expect(audio.isMuted()).toBe(true);
    bus.emit("audio:mute", { muted: false });
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(ctx.oscillators).toHaveLength(1);
  });

  it("unknown blip names are a no-op", () => {
    gesture();
    audio.play("does-not-exist");
    expect(FakeAudioContext.instances[0].oscillators).toHaveLength(0);
  });

  it("dispose closes the context and detaches bus + gesture listeners", () => {
    gesture();
    const ctx = FakeAudioContext.instances[0];
    audio.dispose();
    expect(ctx.closed).toBe(true);
    bus.emit("keeper:selected", { keeperId: "dreams" });
    audio.play("select");
    expect(ctx.oscillators).toHaveLength(0);
  });

  it("survives a missing AudioContext (no WebAudio in the host)", () => {
    delete window.AudioContext;
    const quiet = createAudio({ bus: createBus(), target: window });
    gesture();
    expect(() => quiet.play("select")).not.toThrow();
    quiet.dispose();
  });

  it("wave pitch varies with the wave index", () => {
    const low = BLIPS.wave({ index: 0 })[0];
    const high = BLIPS.wave({ index: 3 })[0];
    expect(high.from).toBeGreaterThan(low.from);
  });
});
