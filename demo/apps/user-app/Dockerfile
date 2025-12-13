FROM node:22-alpine AS builder

# Build args for API URLs (used by Vite at build time)
ARG VITE_API_URL=http://localhost:8082
ARG VITE_CONTEXT_STORE_URL=http://localhost:8081
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_CONTEXT_STORE_URL=$VITE_CONTEXT_STORE_URL

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files (lockfile, workspace config)
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/pci-identity/ ./packages/pci-identity/
COPY apps/user-app/package.json ./apps/user-app/

# Install and build pci-identity first (workspace dependency)
WORKDIR /app/packages/pci-identity
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm build

# Install dependencies for user-app
WORKDIR /app/apps/user-app
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY apps/user-app/ ./

# Build (VITE_API_URL is available as env var)
RUN pnpm build

# Production image with nginx
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/apps/user-app/dist /usr/share/nginx/html

# Copy nginx config for SPA routing
RUN echo 'server { \
    listen 4501; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 4501

CMD ["nginx", "-g", "daemon off;"]
