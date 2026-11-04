# SocialPilot AI: hackathon submission

Everything for the submission form, the demo video script, and the X post. Submit at https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit before **Nov 4, 9 PM ET (Thu Nov 5, 7:45 AM Nepal)**. Aim to submit on Nov 4 during the day.

## Project name

SocialPilot AI

## Tagline

A small business types a goal ("Bhai Tika gift campaign: sisters gifting cashews to their brothers") and Meta's models deliver a ready-to-approve campaign: posts for every platform, real photos and a booking form.

## Track

Startup

## Short description (one or two sentences)

SocialPilot runs social media for small businesses and the agencies that serve them. During the hackathon we added an agent on Meta's open-weight Muse Spark Open that turns a goal into a full campaign, Muse Image photos, a SAM 3.1 product photo studio, and voice-note replies with Muse Voice Transcribe.

## What it does

Small businesses run on Facebook, Instagram and WhatsApp, but few can afford someone to post every day and answer every message. SocialPilot is a working multi-tenant product that agencies and small businesses use to draft posts, get them approved, publish them, answer customers and capture leads, with people approving what goes out.

During the hackathon we added four features built on Meta's models:

- **Campaign Agent (Muse Spark Open + Muse Image):** the owner types a goal. The agent reads the business profile, checks facts in the business's knowledge base, looks at recent posts, writes a 2–5 post campaign with a version for each platform, creates a booking form, has Muse Image make a photo for each post, and sends everything for approval. A live timeline shows each step. If it doesn't know a detail (a date, a price), it writes a clear [placeholder] instead of inventing it.
- **Voice-note inbox (Muse Voice Transcribe):** customers' voice notes are transcribed, with the business's product names as recognition hints, and answered like typed messages from the business's own facts. A recording with no speech is flagged for the team, never guessed at.
- **Product photo studio (SAM 3.1 + Muse Image):** from a phone photo, SAM 3.1 cuts out the named product (just the main product, not copies in the background). The app makes a clean studio shot on the brand colour, and Muse Image places the same product in a new scene, such as a Tihar table with marigolds, diyo lamps and rangoli.
- **Open weights:** Muse Spark Open (Baseten) is the main model; Muse Glimmer can run on your own GPU (a Modal deployment is included). Meta's hosted Muse Spark and NVIDIA are automatic backups.

## How we built it

- **Agent:** an OpenAI-compatible tool-calling loop (up to 24 turns, several tool calls per turn) over seven tools that reuse the product's own services: business profile, knowledge search, recent posts, post drafts, images, sign-up forms, finish. Every result is a draft that waits for human approval. The goal is treated as untrusted input, and the prompt allows only facts from the profile and knowledge base.
- **Muse Spark Open on Baseten:** `meta-models/muse-spark-open-1026`, with reasoning effort set per step (low for writing, minimal for quick checks) instead of the default maximum. A full campaign with photos takes about 2–3 minutes; the text alone about 25 seconds.
- **Muse Image:** `/v1/images/generations` for post photos sized for each platform (saved as JPEG, the one format every publishing platform accepts) and `/v1/images/edits` for studio scenes.
- **SAM 3.1:** streamed from the Responses API and parsed with Meta's `@meta-sam/parser`. Each mask is stretched over its box with smoothing, the main product is kept (the largest match and what touches it), and sharp composites a transparent cutout and a studio shot with a soft shadow.
- **Muse Voice Transcribe:** browser recordings are converted to 16 kHz mono WAV in the browser; WhatsApp audio is downloaded with the account token and converted with ffmpeg, then sent to `/v1/asr/transcribe` with keyword biasing.
- **Reliability:** every AI step fails over automatically (Muse Spark Open → Meta Muse Spark → NVIDIA), and settings refuse keys that are really passwords, model names or error text.
- **Stack:** TypeScript monorepo (Next.js, Fastify, BullMQ, PostgreSQL + pgvector, Redis, Prisma), 295 automated tests, a production Docker setup.

## Challenges

- **Stopping the agent from inventing facts.** Its first campaigns made up dishes and dates. Now it may only use facts from the profile and knowledge base, and anything missing becomes a highlighted [placeholder] for the owner.
- **Tool calling across providers.** Gemini rejected follow-up turns until we returned its "thought signature" with each tool call; the same loop now runs on Muse Spark Open, Meta Muse Spark, Gemini and NVIDIA.
- **Token cost.** The first agent runs used about 58,000 tokens; several tool calls per turn and per-step reasoning effort brought a campaign's text to about 27,000.
- **Silence becoming text.** A test recording with no speech came back as the list of product-name hints; transcription now reports "no speech" and leaves the note for the team.
- **Paying for APIs from Nepal.** Meta's API needs a card on file; Muse Spark Open on Baseten let us build and test the agent on a Meta model while billing was sorted out, and every feature falls back gracefully when a model isn't available.

## Accomplishments we're proud of

A real Tihar campaign for a Nepali food company, Master Chef Food, end to end on Meta's models: Muse Spark Open read the business profile, checked its knowledge base, created a booking form and wrote three Bhai Tika posts for Facebook, Instagram and TikTok with the real price and contact details, and Muse Image made three festive photos, in 12 tool calls and about 2.5 minutes, all waiting for the owner's approval. The photo studio took a jar of dry fruits, cut it out cleanly, and placed the same jar, label intact, on a Tihar table with marigolds, diyos and rangoli.

## What we learned

For a small business, an agent that hands over a well-grounded first draft, and clearly marks what it doesn't know, is worth more than one that posts on its own. Using several Meta models together (text, image, segmentation, speech) is what makes it feel like a real marketing assistant rather than a chatbot.

## What's next

- Meta App Review, so agencies can connect real Facebook Pages, Instagram and WhatsApp accounts (today the platform connections are tested with built-in practice accounts).
- Muse Glimmer on the business's own hardware for agencies that want to self-host.
- A pilot with local agencies and shops in Nepal.

## Built with

Meta Model API (Muse Spark, Muse Image, Muse Voice Transcribe, SAM 3.1), Muse Spark Open (Baseten), Muse Glimmer (vLLM on Modal), TypeScript, Next.js, React, Fastify, PostgreSQL, pgvector, Redis, BullMQ, Prisma, sharp, ffmpeg, Docker.

## New work during the event

SocialPilot existed before the hackathon. The git tag `hackathon-start` marks the code before the event; everything after it is new (see "Built during the Meta AI Developer Hackathon" in the README). The demo video shows only these new features.

## Links

- Code: https://github.com/aancur2002/socialpilot-ai (public, AGPL-3.0)
- Demo video: **[add the YouTube link]**

---

## Demo video script (3:00, new features only)

Everything shown runs live on Meta's models.

**Before recording (10 minutes):**
1. Start the app and open http://localhost:3000 in light mode, at 1920×1080. Log in as owner@demo.local.
2. Settings → AI models → **Test connection**: all OK.
3. Have the Master Chef jar photo ready to upload in the Photo studio (it is already in Master Chef Food's media).
4. Practise once. Speak slowly. Campaigns take about 2–3 minutes with photos, so **trim the waiting while editing**, or record that part in two takes.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | Campaign Agent page, empty | "Small businesses in Nepal, and everywhere, live on Facebook, Instagram and WhatsApp, but nobody has time to plan a campaign. So we built an agent that does it, on Meta's open-weight model, Muse Spark Open." |
| 0:15–0:25 | Type "Bhai Tika gift campaign: sisters gifting cashews to their brothers this Tihar", choose Master Chef Food, set Starts to Nov 5 and Length to 7 days, click Plan the campaign | "The owner just types a goal." |
| 0:25–1:00 | The live timeline filling in (cut the waiting) | "It reads the business profile, checks the facts in the company's own knowledge base, looks at recent posts so it doesn't repeat them, creates a booking form, and writes three posts, each one for Facebook, Instagram and TikTok. Then Muse Image makes a photo for every post." |
| 1:00–1:40 | Result cards; rest the mouse on the price Rs. 5,000. Open a post, click Preview on the Instagram and TikTok versions | "The price and phone number come from the business. If the AI does not know a detail, it leaves a yellow gap. Before posting, the owner can see a preview for each platform, and nothing is posted until a person approves it. In this demo we use practice accounts; real posting needs Meta App Review." |
| 1:40–2:05 | Photo studio: pick the jar photo, type "jar of dry fruits", click Cut out | "For product photos, SAM 3.1 cuts the product out of any picture and we get a clean studio shot on the brand colour." |
| 2:05–2:25 | Choose the Tihar scene, click Create scene, show the result | "And Muse Image puts the same jar on a Tihar table, with marigolds, diyo lamps and rangoli, ready for the festival post." |
| 2:25–2:48 | Inbox → Simulate message → Voice note: record "Hi, how much is one kilo of cashews?", send, open the conversation | "Customers often send voice notes. Muse Voice Transcribe turns them into text, and the AI answers from the company's own prices, holding the reply for the team to check." |
| 2:48–3:00 | Campaign Agent page | "SocialPilot: four Meta models doing the first draft of a small business's marketing, with the owner in charge. Built for our world." |

---

## X post

> Built for my world 🇳🇵 Small businesses here live on Facebook, Instagram & WhatsApp, but nobody has time to plan campaigns.
>
> SocialPilot: type a goal, and Meta's Muse Spark Open writes the campaign, Muse Image makes the photos, SAM 3.1 builds product shots. Owner approves, done.
>
> #MetaAIHackathon [video link]

Check the official hashtag and the accounts to tag in the hackathon Discord before posting.
