# SocialPilot AI: submission draft

Draft text for the hackathon submission form. Update the parts marked **[check]** once the official rules (Oct 26) and Meta billing are settled.

## Tagline

Every client's social media, run from one board: Meta's Muse models write the posts and answer the customers on Meta's own platforms, and people stay in charge.

## Inspiration

Small businesses live on Facebook, Instagram and WhatsApp, but most can't afford someone to post every day and answer every comment and DM. The agencies that help them are stretched across dozens of clients. Messages go unanswered, leads go cold, and posts stop. We wanted one person to be able to run social media for many local businesses without the AI ever saying something the business wouldn't.

## What it does

- **Writes posts:** one idea becomes a separate version for each platform in the client's voice, plus an image from **Muse Image** sized for the platform.
- **Gets approval:** clients or approvers sign off before anything is published; posts go out on schedule.
- **Answers customers:** every comment and DM lands in one inbox. **Muse Spark** labels the intent, drafts a reply from that business's own knowledge base, and scores its confidence. Depending on the client's rules, the reply is sent, held for a person, or escalated (complaints, refunds and anything uncertain always go to a person).
- **Captures leads:** buying intent in a chat, a website form or another tool becomes a lead with a follow-up reminder.
- **Runs as a business:** customer accounts, plans and limits, trials, payments and an admin console.

## How we built it

- **Meta Model API:** Muse Spark (`muse-spark-1.3`) for every text step: post writing, intent triage, grounded replies, lead extraction and reports. Strict JSON-schema outputs are validated before use; quick classification steps use minimal reasoning effort to save tokens. Muse Image (`muse-image-1.0`) for post images.
- **Grounding:** knowledge chunks embedded in PostgreSQL with pgvector; only snippets close in relevance to the best match go into the prompt.
- **Safety:** confidence-based routing, prompt-injection defences (untrusted text isolated in tagged zones, detection, output checks), and automatic failover to backup providers if a model is busy.
- **Efficiency:** about 25% fewer input tokens on classification and extraction after measuring each step; no AI at all for "thanks" or emoji-only messages; lead extraction runs alongside the reply draft.
- **Stack:** TypeScript monorepo with Next.js, Fastify, BullMQ workers, PostgreSQL + pgvector, Redis and Prisma; 267 automated tests plus browser tests; GitHub Actions CI; Docker production setup with automatic HTTPS and daily verified backups.

## Challenges

- **Trusting AI with a business's voice:** we made the AI decide less, not more. It drafts, scores its confidence and explains itself; client rules decide what's sent.
- **Silent knowledge failures:** switching embedding models made the knowledge base quietly unsearchable. We now re-index automatically when the model changes.
- **Model churn:** providers retire models (several backup models we used were retired in 2026), so the app reads live model lists and fails over automatically.
- **Cost:** measuring tokens per step showed the format instructions were being sent twice; removing that cut input tokens by about a quarter.

## Accomplishments we're proud of

A working multi-tenant product, not a demo: tenant isolation on every query, encrypted tokens, audit logs, billing, lead capture, and a one-command production deployment, with Meta's models at its core.

## What we learned

The most useful thing an AI can do for a small business is the first draft, done well, with a clear "I'm not sure" when it isn't. Confidence scores plus human routing earn more trust than full automation.

## What's next

- **During the hackathon [check rules]:** Muse Voice Transcribe for WhatsApp voice notes, SAM 3.1 to cut products out of client photos, and a Meta open-weights backup model.
- Meta App Review, so agencies can connect real Pages (the platform adapters follow Meta's documented Graph API; they're tested with simulated accounts today).
- A pilot with a few local agencies.

## Built with

Meta Model API (Muse Spark, Muse Image), TypeScript, Next.js, React, Fastify, PostgreSQL, pgvector, Redis, BullMQ, Prisma, Docker, Caddy, Playwright, GitHub Actions.

## Links

- Code: https://github.com/aancur2002/socialpilot-ai **[check: make public if the rules require]**
- Demo video: **[add link]**

---

## Narration for the demo video

Timed to the draft recording (`~/Videos/socialpilot-demo-draft.webm`, 2:25). Re-record with Meta billing active so Muse Spark and Muse Image answer live **[check]**.

| Time | On screen | Say |
|---|---|---|
| 0:00 | Landing page | "This is SocialPilot. It lets one person run social media for dozens of local businesses, on Meta's own models and Meta's platforms." |
| 0:14 | Sign-in, dashboard | "Here's an agency's board: three client businesses, what's scheduled, and the messages waiting." |
| 0:24 | A post with its versions | "From one idea, Muse Spark writes a separate post for each platform in the bakery's voice, and Muse Image creates the picture." |
| 0:40 | Approvals | "Nothing goes out until the client or an approver signs off." |
| 0:56 | Calendar | "Approved posts publish on schedule, with retries and no duplicates." |
| 1:11 | Inbox with a draft | "A customer asks if the bakery delivers to Kentish Town. Muse Spark finds the answer in the business's own facts, drafts a reply, and scores its confidence. Because this client wants to review that kind of question, it waits here for a person." |
| 1:30 | A lead | "Buying intent becomes a lead automatically, with where it came from and a follow-up reminder." |
| 1:46 | Lead capture | "Leads also come from a form on the client's website, or from other tools through an API." |
| 2:02 | AI settings | "Muse Spark is the main model, with backups that take over automatically, so replies keep flowing even if a model is busy." |
| 2:17 | Landing page | "SocialPilot: the AI writes the first draft, and people stay in charge." |
