# syntax=docker/dockerfile:1.7
# Multi-stage build for the SocialPilot monorepo. Targets: api, worker, web.
#   docker compose --profile apps up --build

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ── Dependencies (cached on manifests only) ──
FROM base AS deps
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/ai/package.json packages/ai/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/database/package.json packages/database/
COPY packages/database/prisma packages/database/prisma
COPY packages/social/package.json packages/social/
COPY packages/storage/package.json packages/storage/
COPY packages/validation/package.json packages/validation/
RUN npm ci --no-audit --no-fund

# ── Build ──
FROM deps AS build
COPY . .
# Baked into the web app's proxy rewrites at build time.
ARG API_URL=http://api:4000
ENV API_URL=${API_URL}
RUN npx turbo run build --filter=@socialpilot/api --filter=@socialpilot/worker --filter=@socialpilot/web

# ── API ──
FROM base AS api
ENV NODE_ENV=production SERVICE_NAME=api
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/database/prisma ./packages/database/prisma
COPY --from=build /app/apps/api/dist ./apps/api/dist
# Writable directories for the local storage driver (/data/storage is the production volume).
RUN mkdir -p /app/.data /data/storage && chown node:node /app/.data /data/storage
USER node
EXPOSE 4000
# Applies pending migrations, then serves. Run a single API replica for migrations,
# or set SKIP_MIGRATIONS=true and run `npx prisma migrate deploy` as a release step.
CMD ["sh", "-c", "[ \"$SKIP_MIGRATIONS\" = true ] || npx prisma migrate deploy --schema packages/database/prisma/schema.prisma; exec node apps/api/dist/main.js"]

# ── Worker ──
FROM base AS worker
ENV NODE_ENV=production SERVICE_NAME=worker
# ffmpeg converts WhatsApp voice notes (OGG/Opus) to the WAV that Muse Voice Transcribe takes.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
RUN mkdir -p /app/.data /data/storage && chown node:node /app/.data /data/storage
USER node
CMD ["node", "apps/worker/dist/main.js"]

# ── Web (Next.js standalone) ──
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# Static files, including the lead form embed script (/embed/form.js).
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
