import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createConfirm } from "../src/ui/confirm.js";

let root;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
});

describe("createConfirm", () => {
  it("resolves true when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    const confirm = createConfirm({ root });
    const promise = confirm.ask({ title: "Destroy this book?", confirmLabel: "Destroy" });
    expect(screen.getByRole("dialog", { name: "Destroy this book?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Destroy" }));
    await expect(promise).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false when cancel is clicked", async () => {
    const user = userEvent.setup();
    const confirm = createConfirm({ root });
    const promise = confirm.ask({ message: "gone forever", cancelLabel: "Keep it" });
    expect(screen.getByText("gone forever")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    await expect(promise).resolves.toBe(false);
  });

  it("resolves false on Escape", async () => {
    const user = userEvent.setup();
    const confirm = createConfirm({ root });
    const promise = confirm.ask({});
    await user.keyboard("{Escape}");
    await expect(promise).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves true on Enter", async () => {
    const user = userEvent.setup();
    const confirm = createConfirm({ root });
    const promise = confirm.ask({});
    await user.keyboard("{Enter}");
    await expect(promise).resolves.toBe(true);
  });

  it("focuses the confirm button so Enter confirms by default", () => {
    const confirm = createConfirm({ root });
    confirm.ask({ confirmLabel: "Yes" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes" }));
  });

  it("resolves false when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const confirm = createConfirm({ root });
    const promise = confirm.ask({});
    await user.click(root.querySelector(".overlay-backdrop"));
    await expect(promise).resolves.toBe(false);
  });

  it("cancels a previous dialog when a new one opens", async () => {
    const user = userEvent.setup();
    const confirm = createConfirm({ root });
    const first = confirm.ask({ title: "first" });
    const second = confirm.ask({ title: "second" });
    await expect(first).resolves.toBe(false);
    expect(screen.getByRole("dialog", { name: "second" })).toBeTruthy();
    await user.keyboard("{Enter}");
    await expect(second).resolves.toBe(true);
  });

  it("dispose closes an open dialog as cancelled", async () => {
    const confirm = createConfirm({ root });
    const promise = confirm.ask({});
    expect(confirm.isOpen()).toBe(true);
    confirm.dispose();
    await expect(promise).resolves.toBe(false);
    expect(confirm.isOpen()).toBe(false);
  });
});
