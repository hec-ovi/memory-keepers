"""The MCP toolkit: two tools that turn any MCP-capable CLI into the island's
brain. The CLI runs this server (stdio), then loops: serve_next_model_job
blocks until the island thinks, the CLI writes the completion itself, and
submit_model_reply hands it back. Env: AGY_BROKER_URL (default
http://localhost:8765)."""
import os

import httpx
from mcp.server.mcpserver import MCPServer

mcp = MCPServer("memory-keepers-agy")


def broker_client() -> httpx.Client:
    return httpx.Client(base_url=os.environ.get("AGY_BROKER_URL", "http://localhost:8765"),
                        timeout=40)


def next_job(client: httpx.Client) -> dict:
    res = client.get("/jobs/next", params={"wait": 30})
    return res.json()


def send_reply(client: httpx.Client, job_id: str, text: str) -> dict:
    res = client.post(f"/jobs/{job_id}/reply", json={"text": text})
    return res.json()


def serve_next_model_job() -> dict:
    """Wait for the island's next model job (blocks up to ~30 s). Returns
    {job_id, prompt} to answer, or {idle: true} when nothing arrived: call
    again to keep serving. Answer the prompt EXACTLY as it instructs (it
    carries its own output format) and hand the text to submit_model_reply."""
    with broker_client() as client:
        return next_job(client)


def submit_model_reply(job_id: str, text: str) -> dict:
    """Deliver the completion for a job taken from serve_next_model_job.
    text is the full raw reply the prompt asked for, nothing else."""
    with broker_client() as client:
        return send_reply(client, job_id, text)


mcp.add_tool(serve_next_model_job)
mcp.add_tool(submit_model_reply)


if __name__ == "__main__":
    mcp.run()
