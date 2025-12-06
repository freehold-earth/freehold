FROM node:22-alpine AS builder

# Build arg for API URL (used by Vite at build time)
ARG VITE_API_URL=http://localhost:8082
ENV VITE_API_URL=$VITE_API_URL

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files (lockfile, workspace config)
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/business-app/package.json ./apps/business-app/

# Install dependencies for this app
WORKDIR /app/apps/business-app
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY apps/business-app/ ./

# Build (VITE_API_URL is available as env var)
RUN pnpm build

# Production image with nginx
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/apps/business-app/dist /usr/share/nginx/html

# Copy nginx config for SPA routing
RUN echo 'server { \
    listen 3002; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 3002

CMD ["nginx", "-g", "daemon off;"]
