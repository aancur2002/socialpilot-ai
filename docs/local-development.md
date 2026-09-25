# Local development

## Setup

1. `npm install`. npm 11 only runs dependency install scripts for packages listed under `allowScripts` in `package.json` (Prisma and esbuild). `postinstall` generates the Prisma client.
2. `cp env.example .env`, then set `ENCRYPTION_KEY` and `JWT_SECRET`. Keep `AI_PROVIDER=mock`, `EMBEDDING_PROVIDER=mock`, `STORAGE_DRIVER=local` and `SOCIAL_MOCK_MODE=true` to work fully offline.
3. `npm run infra:up` starts `pgvector/pgvector:pg16` on **5434** and `redis:7-alpine` on **6380**. Non-default ports avoid clashing with other local databases. The init script also creates `socialpilot_test` for the integration tests.
4. `npm run db:migrate` applies migrations with `prisma migrate deploy`.
5. `npm run db:seed` loads the demo data. Use `-- --force` to recreate it.
6. `npm run dev` starts the web app, API and worker in watch mode.

The config loader reads `.env` from the working directory or the nearest parent. Set `ENV_FILE=<name>` to use a different file.

## Useful scripts

| Command | What it does |
|---|---|
| `npm run db:migrate:new -- <name>` | Creates a migration without applying it, then strips the `DROP INDEX` Prisma generates for the pgvector HNSW index |
| `npm run db:reset --workspace @socialpilot/database` | Drops and recreates the dev database (destroys data) |
| `npm test` / `npm run test:integration` / `npm run test:e2e` | Unit, integration and browser tests |
| `npm run lint` / `npm run typecheck` | Quality checks |

> Don't run `prisma migrate dev` directly. It reports the HNSW index as drift and asks to reset. Use `db:migrate:new`, review the SQL, then `db:migrate`.

## Working with mock integrations

- Connect a mock account from **Clients → (client) → Social accounts → Add mock account**, or go through the mock consent screen with "Connect" when `mock: true` is passed to `/social/oauth/start`.
- **Inbox → Simulate message** posts a signed webhook for a mock account through `/webhooks` intake, the worker, the AI pipeline and the inbox, the same path real traffic takes. From the API: `POST /api/v1/dev/simulate-inbound`.
- Mock publishing returns `mock_*` post IDs. To exercise the failure paths, put one of these markers in a caption: `[mock:fail-transient]` (retried), `[mock:fail-permanent]` (fails immediately), `[mock:fail-auth]` (flags the account for reconnection) or `[mock:fail-ratelimit]`.
- Mock analytics are deterministic pseudo-metrics, stored with `source=MOCK` and labelled in the UI and in AI reports.

## Using a real AI provider

Set `AI_PROVIDER=anthropic` and `AI_API_KEY=…`, and optionally `AI_MODEL` or `AI_FAST_MODEL`. For semantic knowledge search, also set `EMBEDDING_PROVIDER=openai` with `EMBEDDING_API_KEY`. After changing the embedding provider, re-process the knowledge sources: delete and re-add them, or re-queue them from the API.

## Receiving real webhooks locally

Platforms need a public HTTPS URL. Run a tunnel, for example `cloudflared tunnel --url http://localhost:4000`. Set `WEBHOOK_BASE_URL` to the tunnel URL and configure `https://<tunnel>/webhooks/<platform>` in the platform's developer console. OAuth redirect URIs are `${API_URL}/api/v1/social/oauth/callback/<platform>`.
