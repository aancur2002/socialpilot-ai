# SocialPilot AI

Multi-tenant social media management for agencies: plan and generate content with AI, get client approval, publish on schedule, answer every client's messages and comments from one inbox, capture leads, and report on results.

- **Clients and teams**: organizations hold many client workspaces. Nine roles are enforced in the API, and external users can be limited to the clients they're assigned.
- **Content**: AI writes a separate version of each post for every platform. Posts then move through approval, scheduling and publishing on a calendar, with retries and duplicate protection.
- **Unified inbox**: DMs and comments from all connected accounts in one place. AI drafts replies from each client's knowledge base. Each draft is sent automatically, held for approval or escalated to a person, depending on per-client confidence thresholds, safety rules and automation rules.
- **CRM**: buying intent in a conversation creates a lead automatically. Leads have a pipeline, notes and contacts.
- **Analytics**: platform metrics are stored as historical snapshots, alongside your own activity metrics and AI-written reports. Metrics a platform doesn't provide are shown as unavailable, never estimated.
- **Integrations** use official OAuth and APIs only. Adapters exist for Facebook, Instagram, WhatsApp, LinkedIn and TikTok. Each has a development-only **mock** counterpart, so the whole product runs without platform credentials.

> **Going live with a platform:** sign in as the platform admin, open **Platform admin → Integrations**, copy the redirect and webhook URLs into the platform's developer app, and paste its credentials. Agencies can then connect real accounts, and mock accounts get a **Switch to real account** button that moves their scheduled posts over.

> **Integration status:** the real platform adapters are implemented but **unverified**. None has been tested against a live platform with approved credentials. See [BUILD_STATUS.md](BUILD_STATUS.md) and [docs/integrations](docs/integrations).

## Quick start (local)

Requirements: Node.js 22+ (tested on 24), npm 10+ (tested on 11), Docker.

```bash
# 1. Install dependencies (also generates the Prisma client)
npm install

# 2. Configure the environment
cp env.example .env
#   then set ENCRYPTION_KEY and JWT_SECRET — the commands to generate them are in the file:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # ENCRYPTION_KEY
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # JWT_SECRET

# 3. Start Postgres (pgvector) on :5434 and Redis on :6380
npm run infra:up

# 4. Apply migrations and load demo data
npm run db:migrate
npm run db:seed

# 5. Run web (:3000), API (:4000) and worker together
npm run dev
```

Open http://localhost:3000 and sign in with one of the demo users. Every demo user's password is `demo-password-2026`.

| User | Role |
|---|---|
| owner@demo.local | Organization owner |
| manager@demo.local | Manager |
| content@demo.local | Content manager |
| social@demo.local | Social media manager |
| approver@demo.local | Approver (two clients) |
| client@demo.local | Client (Bella's Bakery only) |
| viewer@demo.local | Viewer (Summit Fitness only) |
| admin@socialpilot.local | Platform super admin |

Or register a new account to go through onboarding. In mock mode, "Add mock account" connects a simulated account, and **Inbox → Simulate message** sends a signed test webhook through the real pipeline.

API docs (OpenAPI UI, outside production): http://localhost:4000/docs. Health: `GET /health` (liveness), `GET /ready` (database, Redis, storage, worker heartbeat).

## Configuration

Every variable is documented in [`env.example`](env.example) and validated at startup. The process refuses to start with a readable list of problems. The main ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Postgres 16 with pgvector, and Redis |
| `ENCRYPTION_KEY` | 32-byte base64 key for AES-256-GCM encryption of OAuth tokens (rotation: `ENCRYPTION_KEY_VERSION`, `ENCRYPTION_KEY_PREVIOUS`) |
| `JWT_SECRET` | Signs cookies and derived secrets |
| `AI_PROVIDER` | `mock` (offline, deterministic), `anthropic` or `openai`, with `AI_API_KEY`. Each organization can override the provider, models and key in **Settings → AI models** |
| `EMBEDDING_PROVIDER` | `mock` (local hashing, lexical only) or `openai` |
| `STORAGE_DRIVER` | `local` (development) or `s3` with the `S3_*` settings |
| `SOCIAL_MOCK_MODE` | Enables the Mock* adapters. Refused in production |
| `FACEBOOK_*`, `INSTAGRAM_*`, `WHATSAPP_*`, `LINKEDIN_*`, `TIKTOK_*` | Platform app credentials (see the integration guides). They can also be managed in **Platform admin → Integrations**, which overrides these |

Production guards: with `NODE_ENV=production` or `APP_ENV=production`, the config refuses mock social providers, the mock AI provider and local storage.

## Tests and quality gate

```bash
npm run typecheck          # every workspace (turbo)
npm run lint               # eslint, zero warnings
npm test                   # unit tests (fast, no services needed)
npm run test:integration   # integration tests: uses the socialpilot_test database and Redis db 1
npm run build              # API and worker (tsup), web (next build)
npm run test:e2e           # Playwright browser tests (needs the stack running and seeded)
```

The first run of `test:e2e` needs a browser: `npx playwright install chromium`.

## Repository layout

```
apps/
  api/        Fastify REST API: auth, tenancy, webhooks, OpenAPI
  worker/     BullMQ workers: publishing, webhooks, AI replies, knowledge, analytics, notifications, maintenance
  web/        Next.js app: dashboard, inbox, content, calendar, CRM, analytics, settings, admin
packages/
  config/     Zod-validated environment
  database/   Prisma schema, migrations (pgvector), client
  auth/       Password hashing, tokens, AES-GCM encryption, RBAC matrix
  validation/ Shared zod request schemas and enums
  social/     Platform adapter interface, capability matrix, real and mock adapters
  ai/         Provider abstraction, versioned prompts, agents, routing, injection defenses
  storage/    S3 / local object storage
  core/       Tenant-scoped business services shared by API and worker
docs/         Architecture, development, deployment, database, AI, security, integrations
infra/        Dockerfile, Postgres init
tests/        Integration tests (Vitest)
```

## Documentation

- [Architecture](docs/architecture.md)
- [Local development](docs/local-development.md)
- [Deployment](docs/deployment.md)
- [Database](docs/database.md)
- [AI system](docs/ai.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- Integrations: [Facebook](docs/integrations/facebook.md), [Instagram](docs/integrations/instagram.md), [WhatsApp](docs/integrations/whatsapp.md), [LinkedIn](docs/integrations/linkedin.md), [TikTok](docs/integrations/tiktok.md)
- Progress: [BUILD_STATUS.md](BUILD_STATUS.md) and [TODO.md](TODO.md)
