# Build context is the repository root: docker build -f agent/Dockerfile .
FROM python:3.13-alpine AS builder
ENV PYTHONUNBUFFERED=1
WORKDIR /app
RUN apk add --no-cache gcc musl-dev postgresql-dev libffi-dev openssl-dev curl
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"
ENV UV_COMPILE_BYTECODE=1
COPY pyproject.toml uv.lock ./
COPY agent/pyproject.toml agent/README.md ./agent/
COPY spec/pyproject.toml spec/README.md ./spec/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-workspace --package freehold-agent
COPY agent/src ./agent/src
COPY spec/src ./spec/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package freehold-agent

FROM python:3.13-alpine
ENV PYTHONUNBUFFERED=1
WORKDIR /app
RUN apk add --no-cache libpq libffi openssl curl
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app/agent/src
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/agent/src ./agent/src
COPY --from=builder /app/spec/src ./spec/src
VOLUME /app/models
EXPOSE 8082
CMD ["python", "-m", "freehold_agent"]
