# SocialPilot AI for the Meta Global AI Developer Hackathon

## The pitch

**SocialPilot AI runs the social media of small businesses on Meta's own stack: Meta's Muse Spark models write the posts and answer the customers, and Meta's platforms (Facebook, Instagram, WhatsApp) are where they go.**

An agency managing 30 local businesses can't read every comment and DM, or write a week of posts for each client. SocialPilot does the first draft of all of it, grounded in each business's own knowledge base, and routes anything uncertain to a person.

## How it uses the Meta Model API

Every AI step runs on Muse Spark through `https://api.meta.ai/v1`:

| Step | What Muse Spark does | Reasoning level |
|---|---|---|
| Post generation | Writes a post per platform in the client's brand voice, with hashtags and a call to action | medium |
| Inbox triage | Reads each comment or DM and labels its intent (question, complaint, lead, spam) | minimal |
| Reply drafts | Answers from the client's knowledge base and scores its own confidence | medium |
| Confidence routing | High confidence can auto-send (if the client allows it); low confidence or complaints go to a person | (rules) |
| Lead capture | Pulls name, need and contact details out of a conversation into the CRM | minimal |
| Reports | Summarizes a client's month in plain language | medium |
| Post images | **Muse Image** (`muse-image-1.0`) turns each post's creative brief into a PNG sized for the platform (portrait for Instagram and TikTok, landscape for LinkedIn, square for Facebook) | n/a |

Structured steps use strict JSON schema output, and every result is checked before it's used. Quick classification steps ask for `reasoning_effort: minimal` to keep credit use low; writing steps use `medium`.

Images cost $0.01 each and count toward the plan's monthly AI allowance, like text generations. Knowledge search needs embeddings, which the Meta Model API doesn't offer, so it uses Google Gemini or NVIDIA embeddings. Both have free tiers.

## Setup with a Meta key (about 5 minutes)

1. Get a key at [dev.meta.ai](https://dev.meta.ai/docs). The hackathon includes $150 of credits.
2. Start the app (see `HOW_TO_USE.md`), sign in as `owner@demo.local`.
3. **Settings → AI models**:
   - Provider: **Meta Model API (Muse Spark)**, paste the key, model `muse-spark-1.3`.
   - Knowledge search: **Google Gemini embeddings** with your Gemini key.
   - Optional: add Google Gemini as a **backup** so the demo keeps working if you hit a rate limit.
4. Click **Test connection**. Then click **Re-index knowledge now** if prompted.

## Demo script (3 minutes)

1. **Dashboard** (15 s): three client businesses, inbox count, scheduled posts.
2. **AI content** (60 s): pick Bella's Bakery, ask for "weekend baking classes". Muse Spark writes Facebook, Instagram and LinkedIn versions in the bakery's voice. Click **Generate image** on the Instagram version: Muse Image draws it from the brief. Submit for approval.
3. **Approvals** (20 s): approve it as the approver, then schedule it on the **Calendar**.
4. **Inbox** (60 s): simulate a customer message, "Do you deliver to Kentish Town?". Show the intent label, the draft answer taken from the knowledge base, and the confidence score. Then send a complaint and show it escalate to a person instead of auto-replying.
5. **Leads** (30 s): a message like "I need 40 cupcakes for a wedding on 12 May, call me on…" lands in the CRM with the details filled in. Then show **Lead capture**: a website form's embed code, and a submission arriving as a lead.
6. **Close** (20 s): Meta models plus Meta platforms, tenant isolation, audit log, and it's a working multi-tenant SaaS, not a prototype.

Record with mock social accounts unless your Meta app has passed App Review. Say so on camera: posts publish to real Pages once the app is approved.

## Before you submit

- [ ] The rules are published when applications open: read them, especially model-use and repository requirements.
- [ ] `.env` and any keys are **not** in the repository (`git log -p | grep -i "api_key"` returns nothing real).
- [x] The README opens with the pitch and screenshots.
- [ ] Meta billing is active on your developer account (the key currently returns HTTP 402), then **Test connection** shows Meta as OK and **Generate image** produces a real picture.
- [ ] Choose a license for the public repository.
- [ ] Demo video recorded with the Meta provider selected (show **Settings → AI models** briefly).
- [ ] `npm run test:all` passes.
- [ ] Keep an eye on credit use: **Settings → General** shows AI generations this month, and your usage is also on the Meta developer dashboard.

## Ideas that would showcase more of Meta's models (not built yet)

- **Muse Voice Transcribe**: transcribe WhatsApp voice notes so they go through the same triage and reply flow.
- **Responses API with web search**: let post ideas reference current local events.
