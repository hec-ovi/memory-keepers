"""Dream dispatch: Pub/Sub in deployment, an inline task in dev and tests.
Both paths end in dreaming.run_dream for the same world."""
import asyncio
import json
import logging
import os

from mk_dreaming import run_dream

log = logging.getLogger(__name__)


class DreamDispatcher:
    def __init__(self, library, agents_api, publisher=None):
        self.library = library
        self.agents_api = agents_api
        self._publisher = publisher
        self.mode = os.environ.get(
            "DREAM_DISPATCH", "pubsub" if os.environ.get("K_SERVICE") else "inline")

    async def dispatch(self, world: str, reason: str) -> None:
        if self.mode == "pubsub":
            self._publish(world, reason)
        else:
            asyncio.get_running_loop().create_task(
                run_dream(self.library, self.agents_api, world, reason))

    def _publish(self, world: str, reason: str) -> None:
        if self._publisher is None:
            from google.cloud import pubsub_v1
            self._publisher = pubsub_v1.PublisherClient()
        topic = self._publisher.topic_path(
            os.environ["GOOGLE_CLOUD_PROJECT"],
            os.environ.get("DREAM_TOPIC", "dream-runs"))
        self._publisher.publish(
            topic, json.dumps({"world_id": world, "reason": reason}).encode())

    async def handle_push(self, envelope: dict) -> dict:
        """Pub/Sub push delivery (base64 payload) or a direct {world_id, reason}."""
        message = envelope.get("message", {})
        if "data" in message:
            import base64
            payload = json.loads(base64.b64decode(message["data"]))
        else:
            payload = envelope
        return await run_dream(self.library, self.agents_api,
                               payload["world_id"], payload.get("reason", "nightly"))
