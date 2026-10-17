# Build context is the repository root: docker build -f context-store/Dockerfile .
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @peteski22/pci-context-store build

FROM node:22-slim
WORKDIR /app
RUN mkdir -p /app/data
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/context-store ./context-store
WORKDIR /app/context-store
EXPOSE 8081
ENV DATA_DIR=/app/data
CMD ["node", "dist/server.js"]
