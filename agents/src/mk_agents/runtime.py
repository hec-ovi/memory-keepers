"""One place that touches ADK's Runner: run an agent for one message and
return its final text plus token usage. Durable memory lives in the library,
so every run gets a fresh in-memory session."""
from google.adk.agents.llm_agent import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.genai import types


def build_agent(name: str, model, instruction: str, tools: list) -> LlmAgent:
    return LlmAgent(name=name, model=model, instruction=instruction, tools=tools)


async def run_agent(agent: LlmAgent, user_text: str) -> tuple[str, int]:
    service = InMemorySessionService()
    runner = Runner(agent=agent, app_name="memory-keepers", session_service=service)
    session = await service.create_session(app_name="memory-keepers", user_id="player")
    final_text, tokens = "", 0
    async for event in runner.run_async(
        user_id="player", session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part(text=user_text)]),
    ):
        usage = getattr(event, "usage_metadata", None)
        if usage and usage.total_token_count:
            tokens += usage.total_token_count
        if event.content and event.content.role == "model":
            texts = [p.text for p in event.content.parts or [] if p.text]
            if texts:
                final_text = "\n".join(texts)
    return final_text, tokens
