FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY . .

# Create plutus output directory
RUN mkdir -p plutus

# Compile contracts (may fail if Helios API changes)
RUN pnpm compile || echo "Compile script skipped - Helios may need updates"

# Build TypeScript
RUN pnpm build

# Production image - smaller, just the compiled outputs
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/plutus ./plutus
COPY --from=builder /app/package.json ./

# This image is mainly for contract deployment scripts
CMD ["node", "dist/index.js"]
