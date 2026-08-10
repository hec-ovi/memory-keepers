#!/usr/bin/env python3
"""Populate a named world with public-domain demo memories through the real
REST surface (each tell runs the live model and writes a real book). Some
keepers come out bulky, some lean, per scripts/demo_world_memories.json.

  ACCESS_CODE=... python3 scripts/demo_world.py <base_url> <world> [--dream]
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


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method, headers=HEADERS,
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def sleep_off(kid):
    status, job = call("POST", f"/keepers/{kid}/sleep", {})
    job_id = job.get("job_id")
    while job_id:
        time.sleep(2)
        status, job = call("GET", f"/keepers/{kid}/sleep/{job_id}")
        if job.get("status") in ("done", "failed"):
            print(f"  {kid}: slept ({job.get('status')})")
            return


def tell(kid, text):
    status, out = call("POST", f"/keepers/{kid}/tell", {"text": text})
    if status == 409 and out.get("error", {}).get("code") == "NEEDS_SLEEP":
        sleep_off(kid)
        status, out = call("POST", f"/keepers/{kid}/tell", {"text": text})
    book = (out.get("book") or {}).get("title") if status == 200 else out
    print(f"  {kid}: [{status}] {book}")


data = json.load(open(os.path.join(os.path.dirname(__file__),
                                   "demo_world_memories.json")))
for keeper in data["keepers"]:
    status, out = call("POST", "/keepers", {"topic": keeper["topic"]})
    kid = out.get("id") or keeper["topic"].replace(" ", "-")
    print(f"{keeper['topic']}: [{status}] {len(keeper['memories'])} memories")
    for text in keeper["memories"]:
        tell(kid, text)

if "--dream" in sys.argv:
    status, out = call("POST", "/dream", {})
    print(f"dream: [{status}] {out.get('run_id', out)}")
