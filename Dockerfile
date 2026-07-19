# syntax=docker/dockerfile:1.7

# Bourse ships as one image. The same immutable artifact is started with the
# `api` or `web` command so both services always run the same product version.

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS workspace
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/ packages/
COPY apps/ apps/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bourse/shared-types build \
 && pnpm --filter @bourse/analysis build

FROM workspace AS app-build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_AUTH_REQUIRED=true
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_AUTH_REQUIRED=$NEXT_PUBLIC_AUTH_REQUIRED \
    NEXT_PUBLIC_APP_VERSION=$APP_VERSION \
    NEXT_PUBLIC_GIT_SHA=$GIT_SHA \
    NEXT_PUBLIC_BUILD_DATE=$BUILD_DATE \
    NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @bourse/api exec prisma generate \
 && pnpm --filter @bourse/api build \
 && pnpm --filter @bourse/web build

FROM base AS bourse
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown

COPY --from=app-build /app /app
COPY docker/entrypoint.sh /usr/local/bin/bourse
RUN chmod +x /usr/local/bin/bourse

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA \
    BUILD_DATE=$BUILD_DATE

EXPOSE 3000 3001
ENTRYPOINT ["bourse"]
