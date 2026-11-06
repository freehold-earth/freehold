# Build context is the repository root: docker build -f demo/apps/user-app/Dockerfile .
FROM node:22-alpine AS builder
ARG VITE_API_URL=https://localhost:8082
ARG VITE_CONTEXT_STORE_URL=https://localhost:8081
ARG VITE_ENABLE_SERVICE_FLOW=true
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_CONTEXT_STORE_URL=$VITE_CONTEXT_STORE_URL
ENV VITE_ENABLE_SERVICE_FLOW=$VITE_ENABLE_SERVICE_FLOW
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter user-app... build

FROM nginx:alpine
COPY --from=builder /app/demo/apps/user-app/dist /usr/share/nginx/html
# Served over TLS only, with the app's certificate from the stack's CA
# (compose mounts it as a secret): the page is where a person types into the
# vault, and it arrives encrypted like everything it then calls.
RUN printf 'server {\n  listen 4501 ssl;\n  ssl_certificate /run/secrets/user_app_cert;\n  ssl_certificate_key /run/secrets/user_app_key;\n  ssl_protocols TLSv1.3;\n  root /usr/share/nginx/html;\n  index index.html;\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 4501
CMD ["nginx", "-g", "daemon off;"]
