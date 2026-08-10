// ui/keepers_list.js: the View keepers holo panel. Renders everyone (day and
// night side) with tiredness dot, level and book count; click selects; the
// crossing shortcut lives in the footer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createBus } from "../src/bus.js";
import { createKeepersList, restHint } from "../src/ui/keepers_list.js";
import { dreamsKeeper, meetingsKeeper, unconsciousKeeper, makeState } from "./ui_fixtures.js";

let root, bus, state, list;

function build(keepers) {
  root = document.createElement("div");
  document.body.appendChild(root);
  bus = createBus();
  state = makeState(keepers);
  list = createKeepersList({ root, state, bus });
}

beforeEach(() => {
  // jsdom has no canvas backend; the holo shard overlay tolerates null.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  build([
    { ...dreamsKeeper(), level: 3, session: { tokens_used: 100, budget: 1000, status: "rested" } },
    { ...meetingsKeeper(), level: 1, session: { tokens_used: 900, budget: 1000, status: "needs_sleep" } },
    { ...unconsciousKeeper(), level: 2 },
  ]);
});

afterEach(() => {
  list.dispose();
  root.remove();
  document.getElementById("mk-keepers-style")?.remove();
  vi.restoreAllMocks();
});

describe("createKeepersList", () => {
  it("opens on keepers_list:open as a holo panel listing every keeper, day and night side", () => {
    expect(list.isOpen()).toBe(false);
    bus.emit("keepers_list:open");
    expect(list.isOpen()).toBe(true);

    const panel = screen.getByLabelText("keepers list");
    expect(panel.classList.contains("holo-panel")).toBe(true);
    expect(screen.getByRole("heading", { name: "The keepers" })).toBeTruthy();

    // both sides of the island, grouped
    expect(screen.getByRole("heading", { name: "the village" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "across the ridge" })).toBeTruthy();

    // every keeper, with name, topic, level and book count
    const dreams = screen.getByRole("button", { name: "view Keeper of Dreams" });
    expect(dreams.textContent).toContain("Keeper of Dreams");
    expect(dreams.textContent).toContain("LV 3");
    expect(dreams.textContent).toContain("2 books");
    const meetings = screen.getByRole("button", { name: "view Keeper of Meetings" });
    expect(meetings.textContent).toContain("LV 1");
    expect(meetings.textContent).toContain("3 books");
    const still = screen.getByRole("button", { name: "view The Still Water" });
    expect(still.textContent).toContain("LV 2");
    expect(still.textContent).toContain("1 book"); // singular
    expect(still.textContent).toContain("fear of water"); // her topic
  });

  it("search filters rows by name or topic; clearing brings everyone back", async () => {
    const user = userEvent.setup();
    bus.emit("keepers_list:open");
    const search = screen.getByLabelText("search keepers");

    await user.type(search, "water");
    expect(screen.getByRole("button", { name: "view The Still Water" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "view Keeper of Dreams" })).toBeNull();

    await user.type(search, "zzz");
    expect(screen.queryAllByRole("button", { name: /^view / })).toHaveLength(0);
    expect(screen.getByText(/no keeper answers to that/)).toBeTruthy();

    await user.clear(search);
    expect(screen.getByRole("button", { name: "view Keeper of Dreams" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "view The Still Water" })).toBeTruthy();
  });

  it("shows a tiredness dot per row (cyan rested, red needs to dream)", () => {
    bus.emit("keepers_list:open");
    const dreams = screen.getByRole("button", { name: "view Keeper of Dreams" });
    const restedDot = dreams.querySelector(".mk-keepers-dot");
    expect(restedDot.classList.contains("mk-keepers-dot--cyan")).toBe(true);
    expect(restedDot.title).toBe("rested");

    const meetings = screen.getByRole("button", { name: "view Keeper of Meetings" });
    const tiredDot = meetings.querySelector(".mk-keepers-dot");
    expect(tiredDot.classList.contains("mk-keepers-dot--red")).toBe(true);
    expect(tiredDot.title).toBe("needs to dream");
  });

  it("clicking a keeper closes the panel and emits keeper:selected", async () => {
    const user = userEvent.setup();
    const selected = vi.fn();
    const modeSet = vi.fn();
    bus.on("keeper:selected", selected);
    bus.on("mode:set", modeSet);
    state.mode = "overworld";
    bus.emit("keepers_list:open");

    await user.click(screen.getByRole("button", { name: "view Keeper of Dreams" }));
    expect(selected).toHaveBeenCalledWith({ keeperId: "dreams" });
    expect(modeSet).not.toHaveBeenCalled(); // already outside
    expect(list.isOpen()).toBe(false);
  });

  it("selecting from inside an interior steps back to the overworld first", async () => {
    const user = userEvent.setup();
    const order = [];
    bus.on("mode:set", (m) => order.push(["mode:set", m]));
    bus.on("keeper:selected", (p) => order.push(["keeper:selected", p]));
    state.mode = "interior:meetings";
    bus.emit("keepers_list:open");

    await user.click(screen.getByRole("button", { name: "view The Still Water" }));
    expect(order).toEqual([
      ["mode:set", "overworld"],
      ["keeper:selected", { keeperId: "still-water" }],
    ]);
  });

  it("keeps the crossing shortcut: Cross the ridge emits district:travel and closes", async () => {
    const user = userEvent.setup();
    const traveled = vi.fn();
    bus.on("district:travel", traveled);
    bus.emit("keepers_list:open");

    await user.click(screen.getByRole("button", { name: "Cross the ridge" }));
    expect(traveled).toHaveBeenCalledTimes(1);
    expect(traveled).toHaveBeenCalledWith({});
    expect(list.isOpen()).toBe(false);
  });

  it("re-renders the open list on state:loaded (levels and counts never go stale)", () => {
    bus.emit("keepers_list:open");
    expect(screen.getByRole("button", { name: "view Keeper of Dreams" }).textContent).toContain(
      "2 books",
    );

    state.keepers[0].book_count = 9;
    state.keepers[0].level = 4;
    bus.emit("state:loaded", { state, consolidation: {} });

    const row = screen.getByRole("button", { name: "view Keeper of Dreams" });
    expect(row.textContent).toContain("9 books");
    expect(row.textContent).toContain("LV 4");
  });

  it("says so warmly when nobody lives on the island yet", () => {
    list.dispose();
    root.remove();
    build([]);
    bus.emit("keepers_list:open");
    expect(screen.getByText(/nobody lives here yet/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "the village" })).toBeNull();
    // the crossing shortcut still works on an empty island
    expect(screen.getByRole("button", { name: "Cross the ridge" })).toBeTruthy();
  });

  it("closes on Escape and via the close button, emitting ui:open/ui:close", async () => {
    const user = userEvent.setup();
    const opened = vi.fn();
    const closed = vi.fn();
    bus.on("ui:open", opened);
    bus.on("ui:close", closed);

    bus.emit("keepers_list:open");
    expect(opened).toHaveBeenCalledWith({ panel: "keepers" });
    await user.keyboard("{Escape}");
    expect(list.isOpen()).toBe(false);
    expect(closed).toHaveBeenCalledWith({ panel: "keepers" });

    bus.emit("keepers_list:open");
    await user.click(screen.getByRole("button", { name: "close keepers list" }));
    expect(list.isOpen()).toBe(false);
  });

  it("leaves Esc to the talk panel when one is open", async () => {
    const user = userEvent.setup();
    bus.emit("keepers_list:open");
    // a stand-in for the open comm panel
    const dialogEl = document.createElement("section");
    dialogEl.className = "mk-dialog";
    document.body.appendChild(dialogEl);

    await user.keyboard("{Escape}");
    expect(list.isOpen()).toBe(true); // the dialog owns Esc first
    dialogEl.remove();
    await user.keyboard("{Escape}");
    expect(list.isOpen()).toBe(false);
  });

  it("double open is a no-op and dispose cleans up", () => {
    bus.emit("keepers_list:open");
    bus.emit("keepers_list:open");
    expect(document.querySelectorAll(".mk-keepers")).toHaveLength(1);
    list.dispose();
    expect(document.querySelector(".mk-keepers")).toBeNull();
    expect(() => bus.emit("keepers_list:open")).not.toThrow(); // unsubscribed
    expect(list.isOpen()).toBe(false);
  });

  it("injects the holo kit styles before its own so .mk-keepers positioning wins the cascade", () => {
    const ids = [...document.head.querySelectorAll("style")].map((s) => s.id);
    expect(ids).toContain("holo-kit-style");
    expect(ids).toContain("mk-keepers-style");
    expect(ids.indexOf("holo-kit-style")).toBeLessThan(ids.indexOf("mk-keepers-style"));
  });
});

describe("restHint (pure)", () => {
  it("maps session status to a warm dot", () => {
    expect(restHint({ status: "rested" })).toEqual({ tone: "cyan", label: "rested" });
    expect(restHint({ status: "unrested" })).toEqual({ tone: "amber", label: "getting tired" });
    expect(restHint({ status: "needs_sleep" })).toEqual({ tone: "red", label: "needs to dream" });
    expect(restHint(null)).toEqual({ tone: "cyan", label: "rested" });
    expect(restHint(undefined)).toEqual({ tone: "cyan", label: "rested" });
  });
});
