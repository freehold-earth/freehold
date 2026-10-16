# Build context is the repository root: docker build -f zkp/Dockerfile .
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @peteski22/pci-zkp-sdk build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/zkp ./zkp
WORKDIR /app/zkp/sdk
EXPOSE 8084
CMD ["node", "dist/server.js"]
