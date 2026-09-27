# Build status

`[x]` means implemented **and** covered by automated tests or verified by running it. `[~]` means implemented but not verified end to end. `[ ]` means not done. The tag after each item says how it was verified:

- **U**: unit tests
- **I**: integration tests (real Postgres and Redis)
- **E**: Playwright browser E2E
- **M**: manually run against the local stack (including screenshots)

Last full run: `npm run typecheck` passed, `npm run lint` passed, `npm test` 116 passed, `npm run test:integration` 52 passed, `npm run build` passed, `npm run test:e2e` 4 passed (against production builds). The E2E suite also passed against the Docker images.

## Phase 1: Foundation
- [x] Monorepo (npm workspaces + Turborepo), strict TypeScript, ESLint (incl. react-hooks). **M**
- [x] Validated environment config with production guards. **U** (via tests), **M**
- [x] Postgres + pgvector, Prisma schema, migrations, HNSW index. **I**
- [x] Redis + BullMQ queues and worker. **I**, **M**
- [x] Authentication (scrypt passwords, hashed session tokens, httpOnly cookies). **U**, **I**, **E**
- [x] Account settings: profile name and password change (signs out other sessions). **I**, **M**
- [x] Organizations, members, invitations. **I**
- [x] RBAC (9 roles, permission matrix, role-escalation guards, client scoping). **U**, **I**, **E**
- [x] Tenant isolation in the service layer. **I**
- [x] Audit log. **I**
- [x] Health `/health` and readiness `/ready` (database, Redis, storage, worker heartbeat). **I**, **M**

## Phase 2: Clients and social
- [x] Clients, brand profiles, per-client AI settings, business hours; searchable timezone picker. **I**, **E**, **M**
- [x] Social adapter interface, capability matrix, normalized errors. **U**
- [x] OAuth architecture (single-use state, PKCE, encrypted token storage, refresh, revoke, key rotation). **U**, **I**, **E** (mock flow)
- [x] Mock providers (MockFacebook, MockInstagram, MockWhatsApp, MockLinkedIn, MockTikTok), refused in production. **U**, **I**, **E**
- [x] Platform status and capability UI. **M**
- [x] Platform app credentials managed in the admin dashboard (encrypted, override .env, credential check for Meta and TikTok). **I**, **M**
- [x] Switch a mock account to a real account, moving its platform versions and scheduled posts. **I**
- [x] Platform admin console (aggregate views; super admins need membership to enter a workspace). **I**, **E**

## Phase 3: Content and AI
- [x] AI provider abstraction (Anthropic, OpenAI-compatible, mock) and embeddings. **U**
- [x] Per-organization AI model settings (provider, models, encrypted keys, connection test, re-index prompt). **I**, **M**
- [~] Anthropic provider against the live API. Written against the official SDK and typechecked, not called with a real key.
- [x] Versioned prompts, zod-validated structured output, retry, generation logs. **U**, **I**
- [x] ContentAgent (per-platform variants, missing-information flagging). **I**, **E**
- [x] Content CRUD, variants, media upload (magic-byte validation). **I**, **M**
- [x] Knowledge base (manual, FAQ, text, PDF, website with SSRF guard), chunking, embeddings, client-isolated vector search. **U**, **I**, **M**
- [x] Knowledge editing (title and text), re-index, refresh from original file or page. **I**, **M**

## Phase 4: Calendar and publishing
- [x] Approval workflow (submit, approve, reject, request changes, re-approval after edits). **I**, **E**
- [x] Scheduling with pre-publish validation. **I**, **E**
- [x] Publishing queue: retries with backoff, non-retryable handling, rate limits, duplicate protection, unknown-outcome handling, re-auth flagging. **I**
- [x] Calendar (month, week, list, drag-and-drop reschedule). **M**

## Phase 5: Inbox
- [x] Webhook intake: signature verification, normalization, idempotency, queue. **U**, **I**
- [x] Conversations, messages, comments, contacts. **I**, **E**
- [x] Unified inbox UI (filters, history, customer panel, assign, priority, escalate, resolve, create lead, AI/human mode). **E**, **M**

## Phase 6: AI replies and automation
- [x] Intent classification, reply drafting, lead extraction, conversation summaries. **I**
- [x] Confidence routing, escalation rules, business hours, human takeover. **U**, **I**
- [x] Prompt-injection defenses and output safety. **U**, **I**
- [x] Spam handling. **I**
- [x] Automation rules engine and builder UI. **U**, **I**, **M**
- [x] Lead detection and CRM (leads, pipeline, contacts, notes). **I**, **E**, **M**

## Phase 7: Analytics and notifications
- [x] Analytics snapshots (append-only), overview, content, platform, lead and AI performance. **I**, **M**
- [x] AnalyticsAgent reports (stored numbers only, caveats for mock data). **I**
- [x] In-app notifications. **I**, **M**
- [x] Email: SMTP via Platform admin (notifications, invitations, password resets, lead alerts); log-only until configured.
- [x] SaaS billing: customer accounts created by the platform admin, plan prices and limits, trials, grace period, manual payments, automatic pausing, suspension, customer billing page.
- [x] Card payments (Stripe Checkout + signed webhook): built and tested, **inactive** until keys pass a check and it's switched on.
- [x] Lead capture: website forms (embed script, iframe, hosted link), lead API with keys, signed outgoing webhooks.
- [x] CRM: company, message, custom answers, tags, follow-up reminders, lost reason, UTM/page source, CSV export.
- [x] Legal pages (/terms, /privacy) with editable text; forgot/reset password; per-account login lockout.
- [x] Production: docker-compose.prod.yml with Caddy (automatic HTTPS), private Postgres/Redis, daily verified backups with restore, CSP and HSTS; docs/deployment.md.

## Phase 8: Production integrations
Adapters are implemented against the official APIs. **None has been run with real credentials**, so none is marked production-ready.
- [~] Facebook Pages (publish text, photo, multi-photo, video; comments; Messenger; insights; webhooks; Page webhook subscription)
- [~] Instagram (image, Reel, carousel publishing; comments; DMs; insights; token refresh; webhooks)
- [~] WhatsApp Cloud API (Embedded Signup, receive, reply within 24 hours). Templates not implemented.
- [~] LinkedIn (member and organization posts, image upload, comments, org statistics). Comment polling and video not implemented.
- [~] TikTok (video and photo direct post with status polling, token refresh, video stats). Consent UX for app audit not implemented.
- [ ] YouTube, X, Pinterest, Google Business Profile, Threads (capability entries reserved; no adapters)

## Phase 9: Security
- [x] Security review, recorded with open items in `docs/security.md`. **M**
- [x] CSRF origin check, per-IP and per-endpoint rate limits, helmet headers, secret redaction. **I** (CSRF), **M**

## Phase 10: Production readiness
- [x] Unit, integration and E2E suites passing. **U**, **I**, **E**
- [x] API and worker production bundles boot and pass `/ready`. **M**
- [x] Docker images for api, worker and web: built, run on the compose network, `/ready` fully ok, browser E2E passed against the containers. **M**, **E**
- [x] Demo seed. **M**
- [x] Documentation (README, architecture, development, deployment, database, AI, security, troubleshooting, integration guides). **M**
- [ ] CI pipeline configuration
- [ ] Billing and payments (plan limits and usage counters are enforced; no payment provider)
