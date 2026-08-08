// The one engine client. Every request in the game goes through here.
// Errors map to ApiError{status, code, message}; idempotent GETs retry.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const RETRIES = 3;

export function createApi({ baseUrl = "", worldId, fetchFn = fetch }) {
  async function request(path, { method = "GET", body, raw = false } = {}) {
    const options = {
      method,
      headers: { "X-World": worldId },
    };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const attempts = method === "GET" ? RETRIES : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await fetchFn(baseUrl + path, options);
      } catch (networkError) {
        lastError = new ApiError(0, "NETWORK", String(networkError));
        continue;
      }
      if (response.ok) {
        return raw ? response : response.json();
      }
      let code = "HTTP_" + response.status;
      let message = "";
      try {
        const data = await response.json();
        if (data.error) ({ code, message } = data.error);
      } catch { /* non-JSON error body */ }
      lastError = new ApiError(response.status, code, message);
      if (response.status < 500) throw lastError;
    }
    throw lastError;
  }

  return {
    health: () => request("/health"),
    state: () => request("/state"),
    createKeeper: (topic) => request("/keepers", { method: "POST", body: { topic } }),
    keeper: (id) => request(`/keepers/${id}`),
    deleteKeeper: (id) => request(`/keepers/${id}`, { method: "DELETE" }),
    tell: (id, text) => request(`/keepers/${id}/tell`, { method: "POST", body: { text } }),
    ask: (id, question) => request(`/keepers/${id}/ask`, { method: "POST", body: { question } }),
    chatter: (id) => request(`/keepers/${id}/chatter`),
    monument: (text) => request("/monument", { method: "POST", body: { text } }),
    books: (id) => request(`/keepers/${id}/books`),
    book: (id, slug) => request(`/keepers/${id}/books/${slug}`),
    deleteBook: (id, slug) => request(`/keepers/${id}/books/${slug}`, { method: "DELETE" }),
    sleep: (id) => request(`/keepers/${id}/sleep`, { method: "POST", body: {} }),
    sleepJob: (id, jobId) => request(`/keepers/${id}/sleep/${jobId}`),
    dream: () => request("/dream", { method: "POST", body: {} }),
    dreamLatest: () => request("/dreams/latest"),
    tts: async (text, kind) => {
      const response = await request("/voice/tts",
        { method: "POST", body: { text, kind }, raw: true });
      return response.blob();
    },
    stt: async (audioBlob) => {
      const response = await fetchFn(baseUrl + "/voice/stt", {
        method: "POST", headers: { "X-World": worldId }, body: audioBlob,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new ApiError(response.status,
          data.error?.code || "HTTP_" + response.status, data.error?.message);
      }
      return response.json();
    },
  };
}

export function worldIdFrom(storage) {
  let id = storage.getItem("mk-world");
  if (!id) {
    id = "w-" + crypto.randomUUID().slice(0, 13);
    storage.setItem("mk-world", id);
  }
  return id;
}
