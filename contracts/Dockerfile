# Build context is the repository root: docker build -f contracts/Dockerfile .
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --ignore-scripts
COPY . .
RUN pnpm install --offline --frozen-lockfile --ignore-scripts
RUN pnpm --filter @freehold-earth/contracts build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/contracts ./contracts
WORKDIR /app/contracts
CMD ["node", "dist/index.js"]
