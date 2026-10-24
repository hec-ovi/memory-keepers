import { describe, expect, it, vi } from "vitest";
import { createBus } from "../src/bus.js";

describe("createBus", () => {
  it("delivers emitted payloads to subscribers", () => {
    const bus = createBus();
    const fn = vi.fn();
    bus.on("mode:changed", fn);
    bus.emit("mode:changed", { mode: "graph" });
    expect(fn).toHaveBeenCalledWith({ mode: "graph" });
  });

  it("off and the unsubscribe return value both stop delivery", () => {
    const bus = createBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on("tick", a);
    bus.on("tick", b);
    offA();
    bus.off("tick", b);
    bus.emit("tick", 0.016);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("only notifies subscribers of the emitted event", () => {
    const bus = createBus();
    const fn = vi.fn();
    bus.on("a", fn);
    bus.emit("b", 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("survives a handler unsubscribing itself mid-emit", () => {
    const bus = createBus();
    const calls = [];
    const off = bus.on("x", () => {
      calls.push("first");
      off();
    });
    bus.on("x", () => calls.push("second"));
    bus.emit("x");
    bus.emit("x");
    expect(calls).toEqual(["first", "second", "second"]);
  });
});
