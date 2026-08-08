"""Ambient speech bubbles: deterministic, stateless, no model and no writes.
A seeded permutation per keeper walked by a time bucket, so lines rotate and
consecutive calls never repeat."""
import hashlib
import time

TOPIC_POOLS = {
    "dreams": [
        "Last night's shelf smells like rain.",
        "Some dreams file themselves under the wrong year.",
        "The flying ones never want a bookmark.",
        "I dust the nightmares gently, they startle.",
        "A short nap still deserves a spine.",
        "Doors in dreams rarely open twice.",
        "I keep the falling ones on the lowest shelf.",
        "One dream keeps asking for a sequel.",
        "The ocean ones drip a little.",
        "Tell me one before it fades, they fade fast.",
    ],
    "meetings": [
        "Everyone said next steps, nobody wrote them.",
        "I file promises under their due date.",
        "That kickoff still echoes a little.",
        "Two coffees equal one honest conversation.",
        "Agendas lie, minutes confess.",
        "I keep who-said-what exactly as said.",
        "Follow-ups age faster than milk.",
        "A good question outlives its meeting.",
        "The budget line worries someone, twice.",
        "Fridays collect the loudest decisions.",
    ],
    "music": [
        "Some songs only work when it rains.",
        "I shelve choruses next to goosebumps.",
        "Track four is where albums tell the truth.",
        "This shelf hums when nobody listens.",
        "Live versions get their own row.",
        "A playlist is a mood with a spine.",
        "The quiet intros hide the big feelings.",
        "One song here refuses alphabetical order.",
        "Basslines are load-bearing.",
        "Hum it to me, I will find it.",
    ],
}

ARCHETYPE_POOLS = {
    "desire": [
        "You circle it and call it a coincidence.",
        "Wanting has its own handwriting.",
        "It returns nightly, politely.",
        "You saved it under a different name.",
        "The shelf warms where you never look.",
        "Some wishes file themselves.",
        "It waits. It is patient. It knows you.",
        "You almost said it out loud yesterday.",
        "Every road you draw bends toward it.",
        "Call it someday. I keep the date open.",
    ],
    "fear": [
        "It gets smaller when read aloud.",
        "You shelve it far, it walks back.",
        "The lock you check is not the door.",
        "It borrows the voice of small hours.",
        "Naming it thins it a little.",
        "It fears being written down, too.",
        "The elevator was never about elevators.",
        "It only visits when you are tired.",
        "I keep it where the light reaches.",
        "Breathe. It is only ink here.",
    ],
    "ambition": [
        "The countdown keeps its own book.",
        "You rehearse even while waiting.",
        "Higher floors, thinner air, same you.",
        "The draft schedule dreams of ink.",
        "Someday has a page number here.",
        "You build ladders in your sleep.",
        "The summit is a shelf like any other.",
        "One minute more was never one minute.",
        "Your Friday promises echo here.",
        "Keep climbing, I will keep the record.",
    ],
    "obsession": [
        "Again. And again. I shelve it again.",
        "The same spine, worn in the same place.",
        "You reread what rereads you.",
        "It loops because you feed the loop.",
        "Every index points here eventually.",
        "One thread, pulled nightly.",
        "You count what does not need counting.",
        "The song under everything is one note.",
        "I filed it twelve times this week.",
        "Rest. The loop keeps itself.",
    ],
}

GENERIC_POOL = [
    "The {topic} shelf grew this week.",
    "One {topic} memory keeps asking for company.",
    "I dusted the {topic} spines today.",
    "Ask me anything about your {topic}.",
    "A thin book of {topic} still counts.",
    "The {topic} index is getting interesting.",
    "Two {topic} books secretly rhyme.",
    "Your {topic} shelf misses you a little.",
    "New {topic} pages settle overnight.",
    "I reread your {topic} books when it rains.",
]

BUCKET_SECONDS = 47  # bubbles rotate roughly every visit, not every frame


def line_for(keeper_id: str, topic: str, side: str, archetype: str | None,
             now: float | None = None) -> str:
    if side == "dark" and archetype in ARCHETYPE_POOLS:
        pool = ARCHETYPE_POOLS[archetype]
    elif topic in TOPIC_POOLS:
        pool = TOPIC_POOLS[topic]
    else:
        pool = [line.format(topic=topic) for line in GENERIC_POOL]
    seed = int.from_bytes(hashlib.sha256(keeper_id.encode()).digest()[:4], "big")
    order = sorted(range(len(pool)), key=lambda i: hashlib.sha256(
        f"{seed}:{i}".encode()).digest())
    bucket = int((now if now is not None else time.time()) // BUCKET_SECONDS)
    return pool[order[(seed + bucket) % len(pool)]]
