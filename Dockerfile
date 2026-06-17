# syntax=docker/dockerfile:1.7
#
# Single image that runs the FastAPI backend AND serves the frontend
# on the same origin (no CORS to worry about). Build from the repo root:
#
#   docker build -t frigate-anpr-logger .
#
# ---------- builder ----------
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

WORKDIR /app

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

# Install deps separately from app source for better layer caching.
COPY backend/pyproject.toml backend/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# ---------- runtime ----------
FROM python:3.12-slim-bookworm

WORKDIR /app

# Pre-built virtualenv from the builder stage.
COPY --from=builder /app/.venv /app/.venv

# Application code + the frontend live side-by-side; main.py mounts /ui
# from /app/frontend/ when that directory exists.
COPY backend/main.py /app/main.py
# Utility scripts (schema migrations live here). main.py imports from
# /app/scripts/ at startup so the DB is migrated before uvicorn comes up.
COPY scripts /app/scripts
# Shipped provider defaults. On first run, if /app/providers is empty (typical
# when the user bind-mounts ./providers:/app/providers from an empty host
# directory), these are copied over so the new install Just Works.
COPY backend/providers /app/providers_default
COPY frontend /app/frontend

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DB_PATH=/data/anpr.db \
    API_PORT=8080

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).status==200 else 1)"

CMD ["python", "main.py"]
