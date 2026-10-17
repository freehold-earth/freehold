# Build context is the repository root: docker build -f demo/apps/user-app/Dockerfile .
FROM node:22-alpine AS builder
ARG VITE_API_URL=http://localhost:8082
ARG VITE_CONTEXT_STORE_URL=http://localhost:8081
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
RUN printf 'server {\n  listen 4501;\n  root /usr/share/nginx/html;\n  index index.html;\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 4501
CMD ["nginx", "-g", "daemon off;"]
