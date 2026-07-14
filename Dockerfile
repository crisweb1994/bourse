# syntax=docker/dockerfile:1.7
#
# Unified build for Bourse.
#
# Pick a target with `--target api` or `--target web` — the compose file
# threads it through automatically. Replaces the previous Dockerfile.api +
# Dockerfile.web pair so deps installation + workspace lib builds happen
# in one shared layer instead of twice.

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# 1. workspace — install all deps, build the shared libs (shared-types,
#    analysis). Same layer reused by both api-build and web-build.
# ---------------------------------------------------------------------------
FROM base AS workspace
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/ packages/
COPY apps/ apps/

RUN pnpm install --frozen-lockfile

# shared-types must build before analysis (analysis depends on it). Each
# downstream app then pulls them via dist/.
RUN pnpm --filter @bourse/shared-types build \
 && pnpm --filter @bourse/analysis build

# ---------------------------------------------------------------------------
# 2a. api — generate Prisma client + compile NestJS.
# ---------------------------------------------------------------------------
FROM workspace AS api-build
RUN pnpm --filter @bourse/api exec prisma generate \
 && pnpm --filter @bourse/api build

FROM base AS api
COPY --from=api-build /app /app
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "-c", "pnpm --filter @bourse/api exec prisma migrate deploy && node apps/api/dist/main"]

# ---------------------------------------------------------------------------
# 2b. web — Next.js production build. NEXT_PUBLIC_* must be baked at
#    build time, hence the ARGs (compose passes them in build.args).
# ---------------------------------------------------------------------------
FROM workspace AS web-build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_AUTH_REQUIRED=true
ENV NEXT_PUBLIC_AUTH_REQUIRED=$NEXT_PUBLIC_AUTH_REQUIRED
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @bourse/web build

FROM base AS web
COPY --from=web-build /app /app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["pnpm", "--filter", "@bourse/web", "start"]
