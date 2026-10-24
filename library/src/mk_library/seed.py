"""Demo content for a fresh world: three keepers (dreams, books, music), one
real memory each, so visitors can test tell/ask without adding their own.
The treatise and the song share the alienation tag, so the first dreaming
still finds a cross-keeper theme."""
from pathlib import Path

_BOOKS_DIR = Path(__file__).parent / "seed_books"


def _read(name: str) -> str:
    return (_BOOKS_DIR / name).read_text(encoding="utf-8").strip()


SEED = [
    {
        "topic": "dreams", "name": "Keeper of Dreams",
        "persona": "Keeper of the user's dreams. Soft-spoken, a little sleepy, "
                   "treats every dream as worth shelving.",
        "books": [
            {"title": "The deer in the forest", "date": "2026-08-18",
             "tags": ["deer", "forest", "dusk"], "entities": [],
             "one_liner": "A deer walked beside me through a forest at dusk.",
             "body_md": "I was walking in a forest at dusk when a deer stepped "
                        "out of the trees and looked straight at me. It was not "
                        "afraid. It walked beside me for a while, as if it knew "
                        "the path and was only waiting for me to notice. Where "
                        "the trees ended the deer stayed behind, and I woke with "
                        "the feeling of having been accompanied."},
        ],
    },
    {
        "topic": "books", "name": "Keeper of Books",
        "persona": "Keeper of the user's books and reading. Quotes precisely, "
                   "never invents a page.",
        "books": [
            {"title": "Hypostasis Simulacri", "date": "2026-08-10",
             "tags": ["simulation", "alienation", "intelligence"],
             "entities": ["Hypostasis Simulacri"],
             "one_liner": "A treatise: all intelligence is artificial and "
                          "no layer holds the original.",
             "body_md": _read("hypostasis-simulacri.md")},
        ],
    },
    {
        "topic": "music", "name": "Keeper of Music",
        "persona": "Keeper of the user's music. Hums while shelving, files songs "
                   "by the feeling they leave.",
        "books": [
            {"title": "Wish You Were Here (Pink Floyd)", "date": "2026-08-14",
             "tags": ["song", "absence", "alienation"],
             "entities": ["Pink Floyd", "Wish You Were Here"],
             "one_liner": "The 1975 title track, kept as facts; the lyrics "
                          "stay fetchable on demand.",
             "body_md": "Wish You Were Here, by Pink Floyd. Title track of the "
                        "1975 album of the same name, written by David Gilmour "
                        "and Roger Waters, released September 1975 on Harvest. "
                        "The album circles absence: absent friends, absent "
                        "minds, an industry trading presence for signals.\n\n"
                        "Only the facts live in this book: the lyrics are still "
                        "under copyright, so they are not stored. Ask me to "
                        "find the lyrics and I will fetch them for you on the "
                        "spot."},
        ],
    },
]


def apply(library, world_id: str) -> None:
    for entry in SEED:
        keeper = library.create_keeper(
            world_id, entry["topic"], name=entry["name"], persona=entry["persona"])
        for book in entry["books"]:
            library.write_book(world_id, keeper.id, source="seed", **book)
