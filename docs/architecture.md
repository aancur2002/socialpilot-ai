# Architecture

## Components

```
Browser ──► web (Next.js, :3000) ──/api/v1/* proxy──► api (Fastify, :4000) ──► Postgres + pgvector
                                                        │   ▲                    Redis (queues, rate limits, locks)
Platforms ──webhooks──► api /webhooks/:platform ────────┘   │                    Object storage (S3 / local)
                                                            │
                                  worker (BullMQ) ──────────┘──► platform APIs, AI provider
```

- **web** only ever calls its own origin. `/api/v1/*` and `/media/local/*` are proxied to the API, so the session cookie stays first-party and CSRF checks see a known Origin.
- **api** handles HTTP: authentication, tenancy resolution, validation, OAuth redirects and webhook intake. Heavy or external work goes to queues.
- **worker** runs every background job. Publishing, webhook processing, the AI reply pipeline, knowledge ingestion, analytics collection, notification email and maintenance all happen here.
- **packages/core** holds all business logic. The API and the worker call the same services, so a rule such as "publishing requires approval" is enforced in one place.

## Tenancy and authorization

```
User ─< OrganizationMember (role, clientAccess) >─ Organization ─< Client ─< SocialAccount, Content, Conversation, Lead, KnowledgeSource, …
                         └─< ClientMember (explicit client assignments)
```

- Every tenant row has `organizationId`, and client-owned rows also have `clientId`.
- Each request resolves an `AuthContext` from the session cookie and the `X-Organization-Id` header, checked against the user's membership. The context carries the role's permissions and the list of clients the user may see (`null` means all).
- Services build every query with `tenantWhere(ctx, clientId?)` and check `requirePermission(ctx, …)`. A resource outside the caller's scope returns **404, not 403**, so other tenants' IDs can't be probed.
- Background jobs use a `SystemContext` bound to one organization.
- The permission matrix lives in `packages/auth/src/rbac.ts`. The `Role` and `Permission` tables mirror it for reporting.

## Main flows

**Publishing**: approve → `scheduleContent` validates each platform version against the capability matrix and creates one `ScheduledPost` per version. Each has a unique idempotency key and a delayed BullMQ job whose ID is the post ID. At run time, `executePublish`:
1. re-checks approval, account status and validation;
2. consumes the platform rate limit (if over the limit, the job is delayed without using up an attempt);
3. claims the post atomically;
4. calls the adapter and records a `PublishedPost` in the same transaction as the status change.

Retryable errors use exponential backoff up to `maxAttempts`. Non-retryable errors fail straight away and notify the team, and auth errors also flag the account for reconnection. A post with a `PublishedPost` is never sent again. A claim interrupted mid-publish is failed as "unknown outcome" rather than retried, so a crash can't produce a duplicate post. A maintenance sweep re-enqueues due posts whose delayed job was lost.

**Inbound messages**: `POST /webhooks/:platform` →
1. verify the HMAC signature over the raw body;
2. the adapter normalizes the payload into events;
3. store one `WebhookEvent` per event and account, with a unique `eventKey` for idempotency;
4. enqueue it.

The worker then upserts the contact and conversation and inserts the message (unique per conversation and platform message ID), which enqueues the AI reply pipeline.

**AI reply pipeline** (`packages/core/src/services/reply.service.ts`), with a per-message Redis lock:
1. conversation memory: recent messages plus a rolling summary;
2. intent classification;
3. automation rules;
4. spam short-circuit;
5. lead extraction;
6. knowledge search, scoped to the client;
7. reply draft;
8. output safety check;
9. `decideReplyRoute` (confidence thresholds and safety rules);
10. business-hours handling;
11. the result: auto-send, approval or escalation.

Details are in [ai.md](ai.md).

## Adapters

`SocialPlatformAdapter` (`packages/social/src/types.ts`) is the only interface the core uses to talk to a platform. Base methods throw `UNSUPPORTED`, so an adapter only overrides what the official API supports. `PLATFORM_CAPABILITIES` describes each API's limits, and the UI, pre-publish validation and the inbox all read from it. Adding a platform means:

1. Implement a class extending `BaseAdapter` in `packages/social/src/adapters/`.
2. Fill in its entry in `PLATFORM_CAPABILITIES` and register it in `SocialAdapterRegistry`.
3. Add its env vars to `packages/config` and `env.example`, and add a doc under `docs/integrations/`.

Mock adapters (`MockSocialAdapter`) reuse the real capability matrix, so validation behaves the same way. Their IDs are prefixed `mock_`, accounts carry `isMock=true`, and they refuse to load in production.

## Queues

| Queue | Job | Notes |
|---|---|---|
| `publish` | `{ scheduledPostId }` | delayed until `scheduledAt`; job ID = post ID |
| `webhook` | `{ webhookEventId }` | 5 attempts |
| `ai-reply` | `{ messageId }` or `send:<suggestionId>` for replies queued until business hours | |
| `knowledge` | `{ sourceId }` | extract → chunk → embed |
| `analytics` | per-account collection, plus a sweep every 6 hours | |
| `notifications` | email delivery | |
| `maintenance` | sweep due posts (5 min), refresh tokens (30 min), cleanup (daily) | job schedulers |

## Observability

Logs are structured pino JSON, with redaction paths for tokens, cookies, passwords and secrets. Request logs include the `requestId`, which is also returned in error bodies. Publishing and pipeline logs include `organizationId`, `clientId`, `platform`, `operation`, `durationMs`, `success` and `error`. `/ready` reports database, Redis, storage and worker heartbeat status.
