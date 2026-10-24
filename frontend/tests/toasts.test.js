import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createToasts } from "../src/ui/toasts.js";

let root;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
  vi.useRealTimers();
});

describe("createToasts", () => {
  it("shows a toast message in a polite live region", () => {
    const toasts = createToasts({ root });
    toasts.show("book saved");
    const region = screen.getByRole("status");
    expect(within(region).getByText("book saved")).toBeTruthy();
  });

  it("applies kind classes for error and success", () => {
    const toasts = createToasts({ root });
    toasts.error("engine unreachable");
    toasts.success("keeper created");
    expect(screen.getByText("engine unreachable").classList.contains("toast-error")).toBe(true);
    expect(screen.getByText("keeper created").classList.contains("toast-success")).toBe(true);
  });

  it("auto-dismisses after the configured duration", () => {
    vi.useFakeTimers();
    const toasts = createToasts({ root, duration: 1000 });
    toasts.show("bye soon");
    expect(screen.getByText("bye soon")).toBeTruthy();
    vi.advanceTimersByTime(999);
    expect(screen.getByText("bye soon")).toBeTruthy();
    vi.advanceTimersByTime(1);
    expect(screen.queryByText("bye soon")).toBeNull();
  });

  it("dismisses on click", async () => {
    const user = userEvent.setup();
    const toasts = createToasts({ root, duration: 60_000 });
    toasts.show("click me away");
    await user.click(screen.getByText("click me away"));
    expect(screen.queryByText("click me away")).toBeNull();
  });

  it("stacks multiple toasts and dispose removes everything", () => {
    const toasts = createToasts({ root, duration: 60_000 });
    toasts.show("one");
    toasts.show("two");
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
    toasts.dispose();
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
