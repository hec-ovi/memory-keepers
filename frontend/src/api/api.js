// Transport-agnostic engine client (docs/api.md contract).
//
//   createApi({ baseUrl })  -> fetch transport against the REST engine
//   createApi({ invoke })   -> transport-style transport; invoke(path, {method, body})
//                              (invoke wins when both are given)
//
// One internal request() peels the three envelope shapes:
//   1. SDK:     { ok, result }            (error: { ok: false, error: {code, message} })
//   2. transport: { success, data: { status, json } }
//   3. bare JSON
// Failures map to ApiError { status, code, message }. Idempotent GETs retry up to
// 3 extra times with backoff (sleep is injectable for tests); POST/DELETE never retry.

const GET_RETRIES = 3;
const BACKOFF_MS = [250, 500, 1000];

export class ApiError extends Error {
  constructor({ status = 0, code = "UNKNOWN", message = "Request failed" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The engine names dreaming routes/codes "dream"; the game speaks "consolidation".
const CODE_ALIAS = {
  DREAM_RUNNING: "CONSOLIDATION_RUNNING",
  DREAM_NOT_FOUND: "NO_CONSOLIDATION",
};

function toApiError(status, payload, fallbackMessage) {
  // payload may be {code, message}, {error: {code, message}}, or anything else.
  const err = isObject(payload) && isObject(payload.error) ? payload.error : payload;
  const rawCode = (isObject(err) && err.code) || null;
  return new ApiError({
    status,
    code: (rawCode && (CODE_ALIAS[rawCode] || rawCode)) || (status >= 500 ? "SERVER_ERROR" : "UNKNOWN"),
    message:
      (isObject(err) && err.message) ||
      fallbackMessage ||
      `Request failed with status ${status}`,
  });
}

// Peels nested envelopes until a bare payload remains, then applies the HTTP
// status (outer or envelope-carried). Throws ApiError on any failure shape.
function peel(status, raw) {
  let payload = raw;
  let st = status;
  for (let depth = 0; depth < 8 && isObject(payload); depth++) {
    if (typeof payload.ok === "boolean" && ("result" in payload || "error" in payload)) {
      if (!payload.ok) throw toApiError(st ?? 0, payload, "SDK envelope reported failure");
      payload = payload.result;
      continue;
    }
    if (typeof payload.success === "boolean" && ("data" in payload || "error" in payload)) {
      if (!payload.success) {
        throw toApiError(st ?? 0, payload, "Transport envelope reported failure");
      }
      if (isObject(payload.data) && ("json" in payload.data || "status" in payload.data)) {
        if (typeof payload.data.status === "number") st = payload.data.status;
        payload = payload.data.json;
        continue;
      }
      payload = payload.data;
      continue;
    }
    break;
  }
  if (typeof st === "number" && st >= 400) throw toApiError(st, payload);
  // Bare error body without a usable status (e.g. invoke transport gave none).
  if ((st === null || st === undefined) && isObject(payload) && isObject(payload.error)) {
    throw toApiError(0, payload);
  }
  return payload;
}

// Every browser gets its own private world; the id is minted once and kept.
export function worldIdFrom(storage) {
  if (!storage) return "w-shared";
  let id = storage.getItem("mk-world");
  if (!id) {
    id = "w-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    storage.setItem("mk-world", id);
  }
  return id;
}

// Keeper payloads carry side ("light" | "dark"); the game also speaks kind.
function normKeeper(k) {
  if (!isObject(k) || !k.side) return k;
  return { ...k, kind: k.side === "light" ? "conscious" : "unconscious" };
}

function normReport(report) {
  if (!isObject(report)) return report;
  return { ...report, created_keepers: (report.created_keepers ?? []).map(normKeeper) };
}

export function createApi({
  baseUrl = "",
  invoke = null,
  worldId = null,
  fetchFn = (...args) => globalThis.fetch(...args),
  sleep = defaultSleep,
} = {}) {
  const base = baseUrl.replace(/\/+$/, "");
  const world = worldId || worldIdFrom(globalThis.localStorage ?? null);

  async function transport(path, { method, body }) {
    if (invoke) {
      // Status may travel inside the envelope; peel() picks it up.
      const raw = await invoke(path, { method, body });
      return { status: null, json: raw };
    }
    const res = await fetchFn(base + path, {
      method,
      headers: {
        "X-World": world,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError({
          status: res.status,
          code: "BAD_RESPONSE",
          message: "Engine returned non-JSON response",
        });
      }
    }
    return { status: res.status, json };
  }

  function isRetryable(err) {
    if (!(err instanceof ApiError)) return true; // network / parse-level failure
    return err.status === 0 || err.status >= 500;
  }

  async function request(path, { method = "GET", body } = {}) {
    const maxAttempts = method === "GET" ? 1 + GET_RETRIES : 1;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
      try {
        const { status, json } = await transport(path, { method, body });
        return peel(status, json);
      } catch (err) {
        lastErr =
          err instanceof ApiError
            ? err
            : new ApiError({ status: 0, code: "NETWORK", message: err?.message || "Network error" });
        if (!isRetryable(lastErr)) throw lastErr;
      }
    }
    throw lastErr;
  }

  const id = encodeURIComponent;

  return {
    request, // escape hatch; prefer the wrappers below

    // meta
    health: () => request("/health"),
    getState: async () => {
      const state = await request("/state");
      return {
        ...state,
        keepers: (state.keepers ?? []).map(normKeeper),
        consolidation: state.consolidation ?? state.dream ?? { latest_run_id: null, running: false },
      };
    },

    // keepers
    createKeeper: ({ topic, name, persona } = {}) =>
      request("/keepers", { method: "POST", body: { topic, ...(name !== undefined && { name }), ...(persona !== undefined && { persona }) } }).then(normKeeper),
    listKeepers: () => request("/keepers").then((list) => (list ?? []).map(normKeeper)),
    getKeeper: (keeperId) => request(`/keepers/${id(keeperId)}`).then(normKeeper),
    deleteKeeper: (keeperId) => request(`/keepers/${id(keeperId)}`, { method: "DELETE" }),
    tell: (keeperId, text) => request(`/keepers/${id(keeperId)}/tell`, { method: "POST", body: { text } }),
    ask: (keeperId, question) => request(`/keepers/${id(keeperId)}/ask`, { method: "POST", body: { question } }),
    getChatter: (keeperId) => request(`/keepers/${id(keeperId)}/chatter`),

    // sessions / sleep (compaction). sleep() -> 202 {job_id}; sleepJob() is
    // the poll target -> {status}. Response fields (grounded/followup on ask,
    // level/session on Keeper) pass through peel() untouched.
    sleep: (keeperId) => request(`/keepers/${id(keeperId)}/sleep`, { method: "POST", body: {} }),
    sleepJob: (keeperId, jobId) => request(`/keepers/${id(keeperId)}/sleep/${id(jobId)}`),

    // books
    listBooks: (keeperId) => request(`/keepers/${id(keeperId)}/books`),
    getBook: (keeperId, slug) => request(`/keepers/${id(keeperId)}/books/${id(slug)}`),
    deleteBook: (keeperId, slug) => request(`/keepers/${id(keeperId)}/books/${id(slug)}`, { method: "DELETE" }),

    // consolidation (engine routes name it dreaming)
    consolidate: () => request("/dream", { method: "POST", body: {} }),
    getLatestConsolidation: () => request("/dreams/latest").then(normReport),
    getConsolidation: (runId) => request(`/dreams/${id(runId)}`).then(normReport),

    // dev helpers
    seed: () => request("/dev/seed", { method: "POST", body: {} }),
    reset: () => request("/dev/reset", { method: "POST", body: {} }),
  };
}
