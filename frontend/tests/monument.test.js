// The monument panel: opens on the bus event, chats through api.monument,
// and a created keeper announces itself and emits "keeper:created".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../src/bus.js";
import { createMonument } from "../src/ui/monument.js";

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("createMonument", () => {
  let root, bus, api, created;

  beforeEach(() => {
    document.body.innerHTML = '<div id="ui"></div>';
    root = document.getElementById("ui");
    bus = createBus();
    created = [];
    bus.on("keeper:created", (k) => created.push(k));
    api = { monument: vi.fn() };
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  function open() {
    const monument = createMonument({ root, bus, api });
    bus.emit("monument:open");
    return monument;
  }

  async function send(text) {
    const input = document.querySelector(".mk-monument-composer input");
    input.value = text;
    document.querySelector(".mk-monument-composer").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
  }

  it("opens on monument:open and renders a cross-shelf reply", async () => {
    api.monument.mockResolvedValue({ reply: "Your dreams and songs both circle Aurora.", created_keeper: null });
    open();
    expect(document.querySelector(".mk-monument")).toBeTruthy();
    await send("what do my memories share?");
    expect(api.monument).toHaveBeenCalledWith("what do my memories share?");
    expect(document.body.textContent).toContain("circle Aurora");
    expect(created).toHaveLength(0);
  });

  it("announces a created keeper and emits keeper:created", async () => {
    const keeper = { id: "films", name: "Keeper of Films", side: "light", kind: "conscious" };
    api.monument.mockResolvedValue({ reply: "Done.", created_keeper: keeper });
    open();
    await send("I want a new keeper for films");
    expect(created).toEqual([keeper]);
    expect(document.body.textContent).toContain("Keeper of Films has her house now");
  });

  it("keeps the panel calm on failure", async () => {
    api.monument.mockRejectedValue(Object.assign(new Error("full"), { code: "KEEPERS_FULL" }));
    open();
    await send("another keeper please");
    expect(document.body.textContent).toContain("No free plots");
  });

  it("dispose unsubscribes and closes", async () => {
    const monument = open();
    monument.dispose();
    await flush();
    bus.emit("monument:open");
    expect(document.querySelectorAll(".mk-monument")).toHaveLength(0); // closed, and no re-open
  });
});
