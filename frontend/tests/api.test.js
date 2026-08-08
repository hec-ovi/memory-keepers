// Pins the api client contract: world header, envelope, error mapping, GET retry.
import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, worldIdFrom } from "../src/api/api.js";

function jsonResponse(status, data) {
  return {
    ok: status < 400, status,
    json: async () => data,
    blob: async () => new Blob(["x"]),
  };
}

describe("api client", () => {
  it("sends the world header and parses payloads", async () => {
    const fetchFn = vi.fn(async (url, options) => {
      expect(options.headers["X-World"]).toBe("w-1");
      expect(url).toBe("/keepers/dreams/tell");
      expect(JSON.parse(options.body).text).toBe("hello");
      return jsonResponse(200, { reply: "kept" });
    });
    const api = createApi({ worldId: "w-1", fetchFn });
    expect((await api.tell("dreams", "hello")).reply).toBe("kept");
  });

  it("maps engine errors to ApiError with the symbol", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(409, { error: { code: "NEEDS_SLEEP", message: "tired" } }));
    const api = createApi({ worldId: "w-1", fetchFn });
    const error = await api.ask("dreams", "?").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("NEEDS_SLEEP");
    expect(error.status).toBe(409);
    expect(fetchFn).toHaveBeenCalledTimes(1); // POST never retries
  });

  it("retries GETs on 5xx up to three times", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      return calls < 3 ? jsonResponse(502, {}) : jsonResponse(200, { status: "ok" });
    });
    const api = createApi({ worldId: "w-1", fetchFn });
    expect((await api.health()).status).toBe("ok");
    expect(calls).toBe(3);
  });

  it("mints one stable world id", () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const id = worldIdFrom(storage);
    expect(id.startsWith("w-")).toBe(true);
    expect(worldIdFrom(storage)).toBe(id);
  });
});
