"""Demo content for a fresh world: three keepers whose books share threads,
so the first dreaming has something real to connect."""

SEED = [
    {
        "topic": "dreams", "name": "Keeper of Dreams",
        "persona": "Keeper of the user's dreams. Soft-spoken, a little sleepy, "
                   "treats every dream as worth shelving.",
        "books": [
            {"title": "The glass elevator", "date": "2026-08-02",
             "tags": ["falling", "city"], "entities": ["Harbor Tower"],
             "one_liner": "Riding a glass elevator that rises past the roof.",
             "body_md": "I was in a glass elevator on the outside of Harbor Tower. "
                        "It kept going past the last floor, into low clouds. I was not "
                        "scared, more curious about how far up it goes. Luna waved from "
                        "the street, tiny below."},
            {"title": "Rehearsing the launch", "date": "2026-08-05",
             "tags": ["space", "waiting"], "entities": ["Mars mission", "Luna"],
             "one_liner": "A dream about waiting in a suit that smells of rain.",
             "body_md": "I stood in a hangar in a suit that smelled like rain, waiting "
                        "for the Mars mission countdown. Luna checked my helmet twice. "
                        "Someone kept postponing the launch by exactly one minute, "
                        "forever."},
            {"title": "The song under water", "date": "2026-08-07",
             "tags": ["ocean", "music"], "entities": ["Aurora"],
             "one_liner": "Hearing Aurora play muffled under a black ocean.",
             "body_md": "I floated over a black ocean and heard Aurora playing from "
                        "under the surface, muffled and slow. Diving made it clearer "
                        "but colder. I woke up before the chorus."},
        ],
    },
    {
        "topic": "meetings", "name": "Keeper of Meetings",
        "persona": "Keeper of the user's meetings and conversations. Precise, "
                   "remembers who said what and when.",
        "books": [
            {"title": "Kickoff with Luna", "date": "2026-08-03",
             "tags": ["work", "planning"], "entities": ["Luna", "Mars mission"],
             "one_liner": "Luna proposed splitting the Mars mission demo in two.",
             "body_md": "Luna and I walked through the Mars mission plan. She wants the "
                        "demo split in two parts: the simulation first, hardware later. "
                        "I promised her a draft schedule by Friday. She was worried "
                        "about the budget line, twice."},
            {"title": "Coffee with Marcos", "date": "2026-08-05",
             "tags": ["catchup", "advice"], "entities": ["Marcos", "Harbor Tower"],
             "one_liner": "Marcos wants to move his studio to Harbor Tower.",
             "body_md": "Marcos is serious about renting a studio floor in Harbor "
                        "Tower. He asked what I thought about the commute and whether "
                        "the light is good for filming. I said the west side floods "
                        "with sun after four."},
        ],
    },
    {
        "topic": "music", "name": "Keeper of Music",
        "persona": "Keeper of the user's music. Hums while shelving, files songs "
                   "by the feeling they leave.",
        "books": [
            {"title": "Aurora, live version", "date": "2026-08-04",
             "tags": ["song", "live"], "entities": ["Aurora"],
             "one_liner": "The live cut of Aurora, slower and warmer than the album.",
             "body_md": "Found a live version of Aurora that drops the drums for the "
                        "first minute. It feels like the underwater way I remember it "
                        "from somewhere. Saved next to the album cut for rainy days."},
            {"title": "Playlist for the launch", "date": "2026-08-06",
             "tags": ["playlist", "focus"], "entities": ["Mars mission"],
             "one_liner": "Nine tracks to play while the Mars mission work gets heavy.",
             "body_md": "Built a nine track playlist for the Mars mission stretch: "
                        "long intros, no vocals until track four, ends with Aurora so "
                        "finishing feels like surfacing."},
        ],
    },
]


def apply(library, world_id: str) -> None:
    for entry in SEED:
        keeper = library.create_keeper(
            world_id, entry["topic"], name=entry["name"], persona=entry["persona"])
        for book in entry["books"]:
            library.write_book(world_id, keeper.id, source="seed", **book)
