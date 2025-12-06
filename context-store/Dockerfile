FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Force rebuild native modules for this specific Node version
RUN npm rebuild better-sqlite3

# Copy source
COPY . .

# Build
RUN pnpm build

# Production image
FROM node:22-slim

WORKDIR /app

# Create data directory
RUN mkdir -p /app/data

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Default port for context store API
EXPOSE 8081

ENV DATA_DIR=/app/data

CMD ["node", "dist/server.js"]
