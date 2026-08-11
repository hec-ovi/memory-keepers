# One image for dev, tests and Cloud Run. The venv lives in /opt/venv, never on the host.
FROM python:3.13-slim AS base
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1
WORKDIR /app

# Dependency layer: lock + manifests only, cached until they change
COPY pyproject.toml uv.lock ./
COPY library/pyproject.toml library/
COPY models/pyproject.toml models/
COPY agents/pyproject.toml agents/
COPY engine/pyproject.toml engine/
COPY dreaming/pyproject.toml dreaming/
COPY voice/pyproject.toml voice/
COPY lookups/pyproject.toml lookups/
COPY agy/pyproject.toml agy/
RUN mkdir -p library/src/mk_library models/src/mk_models agents/src/mk_agents \
    engine/src/mk_engine dreaming/src/mk_dreaming voice/src/mk_voice \
    lookups/src/mk_lookups agy/src/mk_agy && \
    touch library/src/mk_library/__init__.py models/src/mk_models/__init__.py \
    agents/src/mk_agents/__init__.py engine/src/mk_engine/__init__.py \
    dreaming/src/mk_dreaming/__init__.py voice/src/mk_voice/__init__.py \
    lookups/src/mk_lookups/__init__.py agy/src/mk_agy/__init__.py && \
    uv sync --all-packages --all-extras --frozen --no-dev

FROM base AS dev
RUN uv sync --all-packages --all-extras --frozen

FROM base AS serve
COPY . .
EXPOSE 8000
CMD ["sh", "-c", "/opt/venv/bin/uvicorn mk_engine.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
