# Build context is the repository root: docker build -f demo/apps/business-app/Dockerfile .
FROM node:22-alpine AS builder
ARG VITE_API_URL=https://localhost:8082
ARG VITE_ENABLE_SERVICE_FLOW=true
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_ENABLE_SERVICE_FLOW=$VITE_ENABLE_SERVICE_FLOW
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter business-app... build

FROM nginx:1.29-alpine
COPY --from=builder /app/demo/apps/business-app/dist /usr/share/nginx/html
# One template serves both apps; nginx renders it with these at startup. APP
# names the compose secrets the template reads: /run/secrets/${APP}_cert and _key.
COPY demo/apps/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=4502 APP=business_app
EXPOSE 4502
CMD ["nginx", "-g", "daemon off;"]
