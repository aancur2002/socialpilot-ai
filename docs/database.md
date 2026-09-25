# Database

PostgreSQL 16 with pgvector, through Prisma 6 (`packages/database/prisma/schema.prisma`).

## Model overview

| Area | Models |
|---|---|
| Identity and tenancy | `User`, `Session`, `Organization`, `OrganizationMember`, `ClientMember`, `Invitation`, `Role`, `Permission`, `RolePermission`, `UsageCounter` |
| Clients | `Client`, `BrandProfile`, `ClientSettings` |
| Social | `SocialAccount`, `SocialToken` (encrypted), `SocialProfile`, `OAuthState` |
| Content | `Campaign`, `Content`, `ContentVariant`, `MediaAsset`, `VariantMedia`, `Approval`, `ScheduledPost`, `PublishedPost` |
| Inbox | `Contact`, `Conversation`, `Message`, `Comment`, `AiReplySuggestion`, `Escalation` |
| CRM | `Lead`, `LeadNote` |
| Knowledge | `KnowledgeSource`, `KnowledgeChunk` (`embedding vector(1536)`) |
| Automation | `AutomationRule`, `AutomationExecution` |
| Other | `Notification`, `AnalyticsSnapshot`, `AnalyticsReport`, `AiGeneration`, `AuditLog`, `WebhookEvent` |

## Conventions

- Every tenant table has `organizationId`, and client-owned tables also have `clientId`. Both are indexed, together with `createdAt`, `status`, `scheduledAt` and the foreign keys queries filter on.
- **Idempotency is enforced by unique constraints:**
  - `WebhookEvent.eventKey`
  - `Message(conversationId, platformMessageId)`
  - `Comment(socialAccountId, platformCommentId)`
  - `ScheduledPost.idempotencyKey`
  - `PublishedPost(socialAccountId, platformPostId)` and `PublishedPost.scheduledPostId`
  - `AiReplySuggestion.inboundMessageId`
- **Analytics are append-only snapshots**, one row per `(socialAccountId, scopeKey, metric, date)`. `scopeKey` is `account` or a published post ID, which keeps the unique key null-safe. A refresh on the same day updates that day's row, and history is kept.
- **Tokens**: `SocialToken.accessTokenEnc` and `refreshTokenEnc` store AES-256-GCM ciphertext (`v<ver>:<iv>:<tag>:<data>`), with the account ID as associated data. Revocation overwrites the ciphertext.
- **Soft delete**: only `Content.deletedAt`. Other deletes cascade from the organization or client.

## Vector search

The migration `knowledge_vector_index` creates an HNSW index (`vector_cosine_ops`) on `KnowledgeChunk.embedding`. Prisma can't express this index, so:

- use `npm run db:migrate:new -- <name>`, which strips the `DROP INDEX` Prisma generates;
- never accept a migration that drops `KnowledgeChunk_embedding_hnsw_idx`.

Every search query filters on `organizationId` and `clientId`, and on the source's `clientId` too, in the SQL itself (`searchKnowledgeInternal`).

## Migrations

| Command | Use |
|---|---|
| `npm run db:migrate` | Apply pending migrations (`prisma migrate deploy`) |
| `npm run db:migrate:new -- add_something` | Create a migration from schema changes, then review the SQL |
| `npm run db:seed` | Demo data (refuses to run in production) |
