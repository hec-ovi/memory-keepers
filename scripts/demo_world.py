#!/usr/bin/env python3
"""Demo-world test generator: seeds public-domain memories through the real
REST surface (each tell runs the live model and writes a real book), then
verifies the whole loop: one grounded ask per keeper, a dream run to
completion, and a graph summary. Seeding is idempotent: a keeper that
already holds its memories is not re-told.

  ACCESS_CODE=... python3 scripts/demo_world.py <base_url> <world> [--verify] [--memories file.json]

The memories file (default scripts/demo_world_memories.json) lists keepers with
"memories" (told, one book each), optional "remarks" (sent through /say, so the
router files them: notes, extensions or books) and an "ask" to verify.
Exit code 0 when every ask is grounded, sessions replay, the dream settles as
done, bubbles come from books and the ridge answers.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE, WORLD = sys.argv[1].rstrip("/"), sys.argv[2]
HEADERS = {"X-World": WORLD, "content-type": "application/json"}
if os.environ.get("ACCESS_CODE"):
    HEADERS["X-Access-Code"] = os.environ["ACCESS_CODE"]
HTTP_TIMEOUT_S = 120  # one call: a tell runs the live model
SLEEP_POLL_S = 2  # sleep-job poll interval
DREAM_POLLS = 60  # dream run: up to DREAM_POLLS polls, DREAM_POLL_S apart
DREAM_POLL_S = 5
failures: list[str] = []
keeper_ids: dict[str, str] = {}  # topic -> id, remembered when the server minted one


def keeper_id(topic, created=None):
    """One id per topic for seed and verify; the server's when it minted one."""
    if created and created.get("id"):
        keeper_ids[topic] = created["id"]
    return keeper_ids.get(topic) or topic.replace(" ", "-")


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method, headers=HEADERS,
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def sleep_off(kid):
    _, job = call("POST", f"/keepers/{kid}/sleep", {})
    job_id = job.get("job_id")
    while job_id:
        time.sleep(SLEEP_POLL_S)
        _, job = call("GET", f"/keepers/{kid}/sleep/{job_id}")
        if job.get("status") in ("done", "failed"):
            print(f"  {kid}: slept ({job.get('status')})")
            return


def call_rested(method, path, body):
    """tell/ask, sending the keeper to sleep once if the meter is full."""
    status, out = call(method, path, body)
    if status == 409 and out.get("error", {}).get("code") == "NEEDS_SLEEP":
        sleep_off(path.split("/")[2])
        status, out = call(method, path, body)
    return status, out


def seed(keepers):
    for keeper in keepers:
        status, out = call("POST", "/keepers", {"topic": keeper["topic"]})
        kid = keeper_id(keeper["topic"], out)
        _, books = call("GET", f"/keepers/{kid}/books")
        have = len(books) if isinstance(books, list) else 0
        if have >= len(keeper["memories"]):
            print(f"{keeper['topic']}: already holds {have} books, skipping")
            continue
        print(f"{keeper['topic']}: [{status}] telling {len(keeper['memories'])}")
        for text in keeper["memories"]:
            s, out = call_rested("POST", f"/keepers/{kid}/tell", {"text": text})
            title = (out.get("book") or {}).get("title") if s == 200 else out
            print(f"  {kid}: [{s}] {title}", flush=True)
            if s != 200:
                failures.append(f"tell {kid}: {out}")
        for text in keeper.get("remarks", []):
            s, out = call_rested("POST", f"/keepers/{kid}/say", {"text": text})
            landed = (out.get("book_grown") or out.get("book") or {}).get("slug") if s == 200 else out
            print(f"  {kid}: [{s}] {out.get('kind')} -> {landed}", flush=True)
            if s != 200:
                failures.append(f"say {kid}: {out}")


def verify(keepers):
    for keeper in keepers:
        ask = keeper.get("ask")
        if not ask:
            continue
        kid = keeper_id(keeper["topic"])
        s, out = call_rested("POST", f"/keepers/{kid}/ask",
                             {"question": ask["question"]})
        grounded = s == 200 and out.get("grounded") and out.get("sources")
        mark = "ok" if grounded else "NOT GROUNDED"
        if not grounded:
            failures.append(f"ask {kid}: {out}")
        if ask["expect"].lower() not in str(out.get("answer", "")).lower():
            mark += " (answer misses the expected word)"
        print(f"ask {kid}: {mark} -> {str(out.get('answer'))[:90]}", flush=True)
        _, chat = call("GET", f"/keepers/{kid}/chat")
        turns = chat.get("turns") if isinstance(chat, dict) else None
        if not turns:
            failures.append(f"chat {kid}: the session replays nothing")

    status, out = call("POST", "/dream", {})
    if status == 409:  # a run is already going; watch that one instead
        _, out = call("GET", "/dreams/latest")
    run_id = out.get("run_id")
    print(f"dream {run_id}: ", end="", flush=True)
    for _ in range(DREAM_POLLS):
        time.sleep(DREAM_POLL_S)
        _, run = call("GET", f"/dreams/{run_id}")
        if run.get("status") in ("done", "failed"):
            break
    graph = run.get("graph") or {}
    print(run.get("status"))
    print(f"  graph: {len(graph.get('nodes', []))} nodes, "
          f"{len(graph.get('edges', []))} edges")
    print(f"  dark keepers: {[k['name'] for k in run.get('created_keepers', [])]}")
    print(f"  narrative: {str(run.get('narrative'))[:160]}")
    if run.get("status") != "done":
        failures.append(f"dream: {run.get('status')} {run.get('error')}")
    # bubbles come from books now; the ridge answers across the village
    _, state = call("GET", "/state")
    for k in state.get("keepers", []):
        _, bubble = call("GET", f"/keepers/{k['id']}/chatter")
        if bool(bubble.get("line")) != (k.get("book_count", 0) > 0):
            failures.append(f"chatter {k['id']}: line={bubble.get('line')!r} books={k.get('book_count')}")
    dark = [k for k in state.get("keepers", []) if k.get("kind") == "unconscious" or k.get("side") == "dark"]
    for k in dark[:2]:
        s, out = call_rested("POST", f"/keepers/{k['id']}/say",
                             {"text": "why do you think this keeps coming back to me?"})
        ok = s == 200 and out.get("reply")
        print(f"ridge {k['id']}: {'ok' if ok else 'NO REPLY'} -> {str(out.get('reply'))[:120]}", flush=True)
        if not ok:
            failures.append(f"ridge {k['id']}: {out}")


memories_file = (sys.argv[sys.argv.index("--memories") + 1] if "--memories" in sys.argv
                 else os.path.join(os.path.dirname(__file__), "demo_world_memories.json"))
data = json.load(open(memories_file))
seed(data["keepers"])
if "--verify" in sys.argv:
    verify(data["keepers"])
if failures:
    print(f"\n{len(failures)} failure(s):")
    for f in failures:
        print(f"  - {f}")
sys.exit(1 if failures else 0)
