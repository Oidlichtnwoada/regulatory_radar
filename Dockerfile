# syntax=docker/dockerfile:1.7
# One Dockerfile, two runtime targets: `api` (API, worker, migrations, eval) and `web` (nginx + Angular).
ARG NODE_IMAGE=node:26.13.1-trixie-slim

# Node 26 ships npm 11; the repo pins npm 12 (packageManager).
FROM ${NODE_IMAGE} AS node
RUN npm install -g npm@12.2.3 --no-audit --no-fund && npm cache clean --force

FROM node AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci --no-audit --no-fund

FROM deps AS build-api
COPY apps/api apps/api
RUN npm run prisma:generate -w apps/api && npm run build -w apps/api

FROM deps AS build-web
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM node AS api
ENV NODE_ENV=production DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --no-audit --no-fund -w apps/api && npm cache clean --force
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/
COPY --from=build-api /app/apps/api/dist apps/api/dist
COPY data data
COPY openapi openapi
WORKDIR /app/apps/api
USER node
ENTRYPOINT ["node", "dist/main.js"]
CMD ["api"]

FROM nginx:1.30.7-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build-web /app/apps/web/dist/web/browser /usr/share/nginx/html
