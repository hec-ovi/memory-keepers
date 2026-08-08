// Shared fixtures for the ui/ module tests. Not a test file itself.

export const BASE = "http://engine.test";

export const dreamsKeeper = () => ({
  id: "dreams",
  name: "Keeper of Dreams",
  topic: "dreams",
  kind: "conscious",
  archetype: null,
  persona: "Keeper of the user's dreams.",
  palette: { primary: "#f8a7c0", accent: "#7c4a6b" },
  created_at: "2026-07-01T10:00:00Z",
  book_count: 2,
  last_book_at: "2026-07-02T10:05:00Z",
});

export const meetingsKeeper = () => ({
  id: "meetings",
  name: "Keeper of Meetings",
  topic: "meetings",
  kind: "conscious",
  archetype: null,
  persona: "Keeper of transcripts.",
  palette: { primary: "#9fe8c9", accent: "#2f6b57" },
  created_at: "2026-07-01T11:00:00Z",
  book_count: 3,
  last_book_at: null,
});

export const unconsciousKeeper = () => ({
  id: "still-water",
  name: "The Still Water",
  topic: "fear of water",
  kind: "unconscious",
  archetype: "fear",
  persona: "Born from the dreaming.",
  palette: { primary: "#6d5a8f", accent: "#3a2f52" },
  created_at: "2026-07-02T02:00:00Z",
  book_count: 1,
  last_book_at: null,
});

export const flyingBook = () => ({
  slug: "2026-07-02-flying-over-water",
  title: "Flying over water",
  date: "2026-07-02",
  tags: ["flying", "ocean"],
  entities: ["Interstellar", "Mars"],
  source: "told",
  one_liner: "A dream about gliding over a black ocean.",
  body_md: "# The night sky\n\nIt was **calm** and vast.",
  links: ["2026-07-01-the-tide", "meetings/2026-06-30-mars-sync"],
});

export const tideBook = () => ({
  slug: "2026-07-01-the-tide",
  title: "The tide",
  date: "2026-07-01",
  tags: ["ocean"],
  entities: [],
  source: "seed",
  one_liner: "The tide came in slowly.",
  body_md: "Slow water.",
  links: [],
});

export function makeState(keepers = [dreamsKeeper(), meetingsKeeper()]) {
  return { keepers, mode: null, selectedKeeperId: null, district: "day", latestReport: null };
}

// A gate the test opens to release a pending MSW handler.
export function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
