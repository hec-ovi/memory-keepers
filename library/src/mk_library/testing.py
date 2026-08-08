"""In-process fake of the Firestore client subset the Library uses.

Mirrors google-cloud-firestore semantics for: collection().document() chains,
get/set(merge)/delete, stream(), snapshot.exists/.id/.to_dict()/.reference.
Every box's tests use it; the same suites pass against the real emulator when
FIRESTORE_EMULATOR_HOST is set and a real client is injected instead.
"""
import copy


class _Node:
    """One document slot: data (or None) plus named subcollections."""
    def __init__(self):
        self.data = None
        self.collections = {}


class FakeSnapshot:
    def __init__(self, doc_id, node, reference):
        self.id = doc_id
        self.exists = node.data is not None
        self._data = copy.deepcopy(node.data) if node.data is not None else None
        self.reference = reference

    def to_dict(self):
        return self._data


class FakeDocument:
    def __init__(self, doc_id, node):
        self._id = doc_id
        self._node = node

    def get(self):
        return FakeSnapshot(self._id, self._node, self)

    def set(self, data, merge=False):
        if merge and self._node.data is not None:
            self._node.data.update(copy.deepcopy(data))
        else:
            self._node.data = copy.deepcopy(data)

    def delete(self):
        self._node.data = None

    def collection(self, name):
        return FakeCollection(self._node.collections.setdefault(name, {}))


class FakeCollection:
    def __init__(self, docs):
        self._docs = docs  # dict[str, _Node]

    def document(self, doc_id):
        return FakeDocument(doc_id, self._docs.setdefault(doc_id, _Node()))

    def stream(self):
        for doc_id in sorted(self._docs):
            node = self._docs[doc_id]
            if node.data is not None:
                yield FakeSnapshot(doc_id, node, FakeDocument(doc_id, node))


class FakeFirestore:
    def __init__(self):
        self._root = {}

    def collection(self, name):
        return FakeCollection(self._root.setdefault(name, {}))
