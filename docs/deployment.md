# Deployment

## Images

`infra/docker/Dockerfile` builds three targets from the monorepo:

| Target | Runs | Port |
|---|---|---|
| `api` | `prisma migrate deploy` (skip with `SKIP_MIGRATIONS=true`), then `node apps/api/dist/main.js` | 4000 |
| `worker` | `node apps/worker/dist/main.js` | none |
| `web` | Next.js standalone server | 3000 |

```bash
docker build -f infra/docker/Dockerfile --target api -t socialpilot-api .
docker build -f infra/docker/Dockerfile --target worker -t socialpilot-worker .
docker build -f infra/docker/Dockerfile --target web --build-arg API_URL=https://api.internal:4000 -t socialpilot-web .
```

`API_URL` is baked into the web image's proxy rewrites at build time. It must be reachable from the web container. The browser never calls it directly.

Everything locally: `docker compose --profile apps up --build`, with a filled-in `.env`.

## Production checklist

- **Environment**: set `NODE_ENV=production` and `APP_ENV=production`. The config then refuses `SOCIAL_MOCK_MODE=true`, `AI_PROVIDER=mock` and `STORAGE_DRIVER=local`.
- **Secrets**: generate `ENCRYPTION_KEY` and `JWT_SECRET` and keep them in a secret manager. Losing `ENCRYPTION_KEY` makes stored OAuth tokens unrecoverable, and every account would have to reconnect.
- **Database**: Postgres 16 with the `vector` extension available (the migrations create it). Run migrations once per release, either from a single API replica or with `SKIP_MIGRATIONS=true` and a separate release step.
- **Redis**: persistence enabled (AOF). BullMQ needs `maxmemory-policy noeviction`.
- **Storage**: an S3 bucket whose objects are publicly readable, or served through a CDN (`S3_PUBLIC_URL`). Instagram, Facebook and TikTok fetch media from HTTPS URLs, and TikTok requires the domain to be verified in its developer portal.
- **TLS and domains**: serve web and API over HTTPS. Put the API behind a reverse proxy, with `trustProxy` enabled, so the forwarded IP reaches rate limiting and audit logs. Set `APP_URL`, `API_URL`, `WEBHOOK_BASE_URL` and `CORS_ORIGINS`.
- **Scaling**: the API is stateless, and the worker scales horizontally. Publishing claims are atomic, and reply pipelines are locked per message.
- **Monitoring**: probe `/health` for liveness and `/ready` for readiness (it returns 503 when the database or Redis is down). Ship the JSON logs. Check **Platform admin → Queues** for failed jobs.
- **Email**: `EMAIL_DRIVER=log` only logs notification emails. An SMTP transport has to be added before real delivery (see TODO.md).
- **Integrations**: complete each platform's app review (see `docs/integrations`) and verify end to end before relying on it.

## Key rotation

1. Move the current key to `ENCRYPTION_KEY_PREVIOUS="<oldVersion>:<oldKey>"`.
2. Set a new `ENCRYPTION_KEY` and increment `ENCRYPTION_KEY_VERSION`.
3. Deploy, then run `TokenService.rotateKeys()`, for example with `tsx -e "import('@socialpilot/core').then(c => c.TokenService.rotateKeys()).then(console.log)"`, to re-encrypt stored tokens.
4. Remove the previous key once the rotation reports 0 remaining.
