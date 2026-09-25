# Build status

`[x]` means implemented **and** covered by automated tests or verified by running it. `[~]` means implemented but not verified end to end. `[ ]` means not done. The tag after each item says how it was verified:

- **U**: unit tests
- **I**: integration tests (real Postgres and Redis)
- **E**: Playwright browser E2E
- **M**: manually run against the local stack (including screenshots)

Last full run: `npm run typecheck` ✓ · `npm run lint` ✓ · `npm test` 116 ✓ · `npm run test:integration` 34 ✓ · `npm run build` ✓ · `npm run test:e2e` 3 ✓

## Phase 1: Foundation
- [x] Monorepo (npm workspaces + Turborepo), strict TypeScript, ESLint (incl. react-hooks). **M**
- [x] Validated environment config with production guards. **U** (via tests), **M**
- [x] Postgres + pgvector, Prisma schema, migrations, HNSW index. **I**
- [x] Redis + BullMQ queues and worker. **I**, **M**
- [x] Authentication (scrypt passwords, hashed session tokens, httpOnly cookies). **U**, **I**, **E**
- [x] Organizations, members, invitations. **I**
- [x] RBAC (9 roles, permission matrix, role-escalation guards, client scoping). **U**, **I**, **E**
- [x] Tenant isolation in the service layer. **I**
- [x] Audit log. **I**
- [x] Health `/health` and readiness `/ready` (database, Redis, storage, worker heartbeat). **I**, **M**

## Phase 2: Clients and social
- [x] Clients, brand profiles, per-client AI settings, business hours. **I**, **E**
- [x] Social adapter interface, capability matrix, normalized errors. **U**
- [x] OAuth architecture (single-use state, PKCE, encrypted token storage, refresh, revoke, key rotation). **U**, **I**, **E** (mock flow)
- [x] Mock providers (MockFacebook, MockInstagram, MockWhatsApp, MockLinkedIn, MockTikTok), refused in production. **U**, **I**, **E**
- [x] Platform status and capability UI. **M**

## Phase 3: Content and AI
- [x] AI provider abstraction (Anthropic, OpenAI-compatible, mock) and embeddings. **U**
- [~] Anthropic provider against the live API. Written against the official SDK and typechecked, not called with a real key.
- [x] Versioned prompts, zod-validated structured output, retry, generation logs. **U**, **I**
- [x] ContentAgent (per-platform variants, missing-information flagging). **I**, **E**
- [x] Content CRUD, variants, media upload (magic-byte validation). **I**, **M**
- [x] Knowledge base (manual, FAQ, text, PDF, website with SSRF guard), chunking, embeddings, client-isolated vector search. **U**, **I**, **M**

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
- [~] Email notifications: architecture and log driver only; no SMTP transport.

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
- [~] Docker images: Dockerfile with api, worker and web targets (see the final report for build results).
- [x] Demo seed. **M**
- [x] Documentation (README, architecture, development, deployment, database, AI, security, troubleshooting, integration guides). **M**
- [ ] CI pipeline configuration
- [ ] Billing and payments (plan limits and usage counters are enforced; no payment provider)
