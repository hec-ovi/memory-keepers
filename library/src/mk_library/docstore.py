"""Document store on SQLite: collection().document() chains over one table.

A document lives at a slash path (worlds/w1/keepers/k1); its collection path
is the parent. Documents hold JSON dicts, set(merge=True) updates top-level
fields, and deleting a document leaves its subcollections to the caller.
Thread-safe: one connection behind a lock, so sync tools may run off-loop.
"""
import json
import os
import sqlite3
import threading

SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
    path   TEXT PRIMARY KEY,
    parent TEXT NOT NULL,
    id     TEXT NOT NULL,
    data   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_parent ON docs (parent, id);
"""


class DocStore:
    def __init__(self, path: str):
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._lock = threading.Lock()
        if path != ":memory:":
            self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)

    def collection(self, name: str) -> "Collection":
        return Collection(self, name)

    # -- row access, one statement per call under the lock ------------------
    def _read(self, path: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT data FROM docs WHERE path = ?", (path,)).fetchone()
        return json.loads(row[0]) if row else None

    def _write(self, path: str, parent: str, doc_id: str, data: dict, merge: bool) -> None:
        with self._lock:
            if merge:
                row = self._db.execute("SELECT data FROM docs WHERE path = ?", (path,)).fetchone()
                if row:
                    data = json.loads(row[0]) | data
            self._db.execute(
                "INSERT INTO docs (path, parent, id, data) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (path) DO UPDATE SET data = excluded.data",
                (path, parent, doc_id, json.dumps(data, ensure_ascii=False)))

    def _delete(self, path: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM docs WHERE path = ?", (path,))

    def _children(self, parent: str) -> list[tuple[str, dict]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT id, data FROM docs WHERE parent = ? ORDER BY id", (parent,)).fetchall()
        return [(doc_id, json.loads(data)) for doc_id, data in rows]


class Snapshot:
    def __init__(self, doc_id: str, data: dict | None, reference: "Document"):
        self.id = doc_id
        self.exists = data is not None
        self._data = data
        self.reference = reference

    def to_dict(self) -> dict | None:
        return self._data


class Document:
    def __init__(self, store: DocStore, parent: str, doc_id: str):
        self._store, self._parent, self.id = store, parent, doc_id
        self._path = f"{parent}/{doc_id}"

    def get(self) -> Snapshot:
        return Snapshot(self.id, self._store._read(self._path), self)

    def set(self, data: dict, merge: bool = False) -> None:
        self._store._write(self._path, self._parent, self.id, dict(data), merge)

    def delete(self) -> None:
        self._store._delete(self._path)

    def collection(self, name: str) -> "Collection":
        return Collection(self._store, f"{self._path}/{name}")


class Collection:
    def __init__(self, store: DocStore, path: str):
        self._store, self._path = store, path

    def document(self, doc_id: str) -> Document:
        return Document(self._store, self._path, doc_id)

    def stream(self):
        for doc_id, data in self._store._children(self._path):
            yield Snapshot(doc_id, data, self.document(doc_id))
