# TODO

Work remaining after the MVP, grouped by priority. Finished work is recorded in BUILD_STATUS.md.

## Required before going live with real platforms
- [ ] Create Meta, LinkedIn and TikTok developer apps. Configure redirect URIs and webhooks (see `docs/integrations/*`).
- [ ] Complete Meta App Review and business verification for the Facebook and Instagram permissions.
- [ ] Apply for the LinkedIn Community Management API, then set `LINKEDIN_ORGANIZATION_SCOPES=true`.
- [ ] Build the TikTok pre-post consent UX (creator nickname, privacy selector, interaction toggles), then apply for the TikTok app audit.
- [ ] Verify each adapter end to end with the checklists in `docs/integrations/*`, then update BUILD_STATUS.md.
- [ ] WhatsApp: verify the redirect-based Embedded Signup, or switch to the JS SDK popup flow.
- [ ] Configure S3 with a public or CDN URL, and verify the media domain with TikTok.
- [ ] Set `AI_PROVIDER=anthropic` and `EMBEDDING_PROVIDER=openai` with keys, re-process knowledge sources, and spot-check reply quality against real FAQs.

## Product gaps
- [ ] WhatsApp template messages, for replies outside the 24-hour window.
- [ ] Messenger and Instagram: detect the 24-hour window up front and explain it before a send fails.
- [ ] LinkedIn comment polling (LinkedIn has no general webhooks), and a generic comment-polling job for platforms without comment webhooks.
- [ ] LinkedIn video upload; Instagram Stories; Facebook Reels.
- [ ] Media download for inbound WhatsApp and DM attachments.
- [ ] Image generation from `mediaPrompt` through a pluggable image provider.
- [ ] Bulk actions in the inbox and content list; saved inbox views.
- [ ] Campaign management UI (campaigns exist in the API and data model).
- [ ] Contact edit and merge UI (the API supports editing).
- [ ] Knowledge source re-processing button, and a scheduled refresh for website sources.
- [ ] Per-post analytics charts over time (snapshots are stored daily).
- [ ] Scheduled weekly report emails.
- [ ] Adapters for YouTube, X, Pinterest, Google Business Profile and Threads.

## Platform and operations
- [ ] SMTP (or provider) transport for notification emails, plus per-user notification preferences.
- [ ] Email verification, password reset and optional MFA.
- [ ] Per-account login lockout, in addition to the per-IP limit.
- [ ] Malware scanning for uploaded documents.
- [ ] CI pipeline running typecheck, lint, unit, integration (with service containers) and E2E.
- [ ] OpenTelemetry tracing and metrics export (logs are already structured JSON).
- [ ] Payment provider integration (plans, limits and usage counters already exist).
- [ ] Data retention jobs (old webhook payloads, AI generation outputs, audit log archival).
- [ ] `npm prune --omit=dev` in the Docker runtime stages to slim the images.
