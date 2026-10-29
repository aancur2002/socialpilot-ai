# SocialPilot AI: hackathon submission

Text for the submission form, the demo video script, and the X post. Submit at https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit before **Nov 4, 9 PM ET (Nov 5, 7:45 AM Nepal)**.

## Project name

SocialPilot AI

## Tagline

A small business tells the AI what it wants ("fill our weekend baking classes") and gets a ready-to-approve campaign, written on Meta's open-weight Muse Spark Open.

## Track

Startup

## What it does

Small businesses run on Facebook, Instagram and WhatsApp, but few can afford someone to post every day and answer every message. SocialPilot is a working multi-tenant product that agencies and small businesses use to draft posts, get them approved, publish them, answer customers and capture leads, with people approving what goes out.

During the hackathon we added four features built on Meta's models:

- **Campaign Agent (Muse Spark Open):** the owner types a goal. The agent reads the business profile, checks facts in the business's knowledge base, looks at recent posts, writes a 2–5 post campaign with a version for each platform, creates a booking form and images, and sends it all for approval. A live timeline shows each step. If it doesn't know a detail (a date, a price), it writes a clear [placeholder] instead of inventing it.
- **Voice-note inbox (Muse Voice Transcribe):** WhatsApp voice notes are transcribed, with the business's product names as recognition hints, and answered like typed messages.
- **Product photo studio (SAM 3.1 + Muse Image):** from a phone photo, SAM 3.1 cuts out the named product; the app makes a clean studio shot and Muse Image places the product in a new scene, such as a Dashain table or a Himalayan backdrop.
- **Open weights:** Muse Spark Open on Baseten, or Muse Glimmer on your own Modal GPU, as the main model or a backup.

## How we built it

- **Agent:** an OpenAI-compatible tool-calling loop (up to 24 turns, several tool calls per turn) over seven tools that reuse the product's own services: business profile, knowledge search, recent posts, post drafts, images, sign-up forms, finish. Every result is a draft that waits for human approval. The goal is wrapped as untrusted input, and the prompt allows only facts from the profile and knowledge base.
- **Muse Spark Open on Baseten:** `meta-models/muse-spark-open-1026` with reasoning effort set per step (low for writing, minimal for quick checks) instead of the default maximum, so a full campaign takes about 25 seconds and about 27,000 tokens. Backups (Gemini, NVIDIA) take over automatically.
- **Voice:** browser recordings are converted to 16 kHz mono WAV in the browser; WhatsApp audio is downloaded with the account token and converted with ffmpeg, then sent to Muse Voice Transcribe (`/v1/asr/transcribe`) with keyword biasing.
- **SAM 3.1:** streamed from the Responses API and parsed with Meta's `@meta-sam/parser`; each mask is stretched over its box with smoothing, then composited with sharp into a transparent cutout and a studio shot. Muse Image edits (`/v1/images/edits`) create the scenes.
- **Muse Glimmer on Modal:** vLLM 0.28 on one H100 with the `muse_glimmer` tool-call and reasoning parsers, scaling to zero when idle.
- **Stack:** TypeScript monorepo (Next.js, Fastify, BullMQ, PostgreSQL + pgvector, Redis, Prisma), 290+ automated tests, Docker production setup.

## Challenges

- **Stopping the agent from inventing facts.** Its first campaigns made up dishes and dates. Now it may only use facts from the profile and knowledge base, and anything missing becomes a highlighted [placeholder] the owner fills in.
- **Tool calling across providers.** Gemini rejected follow-up turns until we returned its "thought signature" with each tool call; the same loop now works on Muse Spark Open, Gemini and NVIDIA.
- **Token cost.** The first agent runs used about 58,000 tokens; letting it make several tool calls per turn and setting reasoning effort cut a full campaign to about 27,000.
- **Paying for APIs from Nepal.** Meta's API needs an international card. Muse Spark Open on Baseten let us run the whole agent on a Meta model anyway, and every feature falls back gracefully when a model isn't available.

## Accomplishments we're proud of

The Campaign Agent runs end to end on Meta's open-weight model: 13 tool calls, 4 posts for 4 platforms, a booking form and images in about 25 seconds, all grounded in the business's own facts and waiting for approval.

## What we learned

For a small business, an agent that hands over a well-grounded first draft, and clearly marks what it doesn't know, is worth more than one that posts on its own.

## What's next

- Run the voice, photo and image features live once Meta billing is active, and the Campaign Agent on Muse Glimmer for businesses that want to self-host.
- Meta App Review so agencies can connect real Pages.
- A pilot with local agencies in Nepal.

## Built with

Meta Model API (Muse Spark, Muse Image, Muse Voice Transcribe, SAM 3.1), Muse Spark Open (Baseten), Muse Glimmer (Modal, vLLM), TypeScript, Next.js, Fastify, PostgreSQL, pgvector, Redis, BullMQ, Prisma, sharp, ffmpeg, Docker.

## New work during the event

SocialPilot existed before the hackathon. The git tag `hackathon-start` marks the code before the event; everything after it is new (see "Built during the Meta AI Developer Hackathon" in the README). The demo video shows only these new features.

## Links

- Code: https://github.com/aancur2002/socialpilot-ai
- Demo video: **[add the YouTube link]**

---

## Demo video script (3:00, new features only)

Record at 1920×1080 with the app in light mode. Before recording, run `npm run demo:reset` so the demo data is fresh, and keep Muse Spark Open (Baseten) as the main AI model. Speak slowly; each line fits its time slot.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | Campaign Agent page, empty | "Small businesses in Nepal and everywhere live on Facebook, Instagram and WhatsApp, but nobody has time to plan a campaign. So we built an agent that does it, on Meta's open-weight model, Muse Spark Open." |
| 0:15–0:30 | Type the goal "Fill our weekend sourdough baking classes this month", choose Bella's Bakery, click Start | "The bakery owner just types a goal. That's it." |
| 0:30–1:05 | The live timeline filling in step by step | "Watch it work. It reads the business profile, then checks the facts in the bakery's own knowledge base: the price, the address, when classes run. It looks at recent posts so it doesn't repeat them, creates a booking form, then writes four posts, each one for Instagram, Facebook, TikTok and LinkedIn." |
| 1:05–1:30 | Result cards; point at a yellow [placeholder] | "Every fact comes from the business. Where it doesn't know something, like the exact dates, it doesn't invent it. It leaves a highlighted gap for the owner. Nothing is published until a person approves it." |
| 1:30–1:40 | The model name on the run (muse-spark-open-1026) | "That whole campaign took about 25 seconds on Muse Spark Open." |
| 1:40–2:10 | Inbox → Simulate message → Voice note: record "Hi, do you have gluten-free bread on Saturday?", send, open the conversation | "Many customers don't type, they send voice notes. SocialPilot transcribes them with Meta's Muse Voice Transcribe, and the AI answers from the business's facts, just like a typed message." |
| 2:10–2:45 | Photo studio: pick a product photo, type "cake", click Cut out, then pick the Dashain scene and click Create scene | "And for photos: SAM 3.1 cuts the product out of a quick phone picture. We get a clean studio shot, and Muse Image puts the same cake on a Dashain table, ready to post." |
| 2:45–3:00 | Campaign Agent page or Approvals | "SocialPilot: Meta's models do the first draft of a small business's marketing, and the owner stays in charge. Built for our world." |

If Meta billing isn't active when you record, the voice note shows a Gemini transcript and the photo studio shows placeholder images. In that case, shorten those two scenes and give the extra time to the Campaign Agent.

---

## X post

> Built for my world 🇳🇵 Small businesses here live on Facebook, Instagram & WhatsApp, but nobody has time to plan campaigns.
>
> So I built an agent on @Meta's open-weight Muse Spark Open: type a goal, get a full campaign with posts, booking form & images, ready to approve, in 25 seconds.
>
> #MetaAIHackathon [video link]

Check the official hashtag and account to tag in the hackathon Discord before posting.
