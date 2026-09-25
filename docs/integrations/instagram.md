# Instagram

**Status: implemented, unverified.** Uses the **Instagram API with Instagram Login** (`packages/social/src/adapters/instagram.ts`). It hasn't been tested against a real app. Confirm details against Meta's current docs before production.

## Developer requirements

1. A Meta app with the **Instagram** product. Choose "API setup with Instagram login".
2. Connected accounts must be Instagram **Business or Creator** accounts. Personal accounts are not supported by the API.
3. **App Review** (Advanced Access) for the scopes below, plus business verification, before the public can connect.

## Credentials

Enter them in **Platform admin → Integrations** (recommended: encrypted, no restart, with a credential check), or set the environment variables below. Values saved in the dashboard override the environment. The Integrations card also shows the exact redirect URI and webhook URL to copy into the developer console.


| Variable | Value |
|---|---|
| `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` | Instagram app ID and secret (from the Instagram product settings) |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | Random string for webhook verification |
| `META_GRAPH_API_VERSION` | Graph version used for `graph.instagram.com` |

Redirect URI: `${API_URL}/api/v1/social/oauth/callback/instagram`

## OAuth flow

1. `https://www.instagram.com/oauth/authorize`
2. `POST https://api.instagram.com/oauth/access_token` returns a short-lived token.
3. `GET graph.instagram.com/access_token?grant_type=ig_exchange_token` returns a **long-lived token (60 days)**.
4. The maintenance job refreshes tokens within 24 hours of expiry (`refresh_access_token`). A token must be at least 24 hours old to refresh.

## Scopes

`instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_messages`, `instagram_business_manage_insights`

## Webhooks

`${WEBHOOK_BASE_URL}/webhooks/instagram`. Subscribe to `comments` and `messages`. The payload `object` is `instagram`, and the signature is `X-Hub-Signature-256` with the Instagram app secret.

## Implemented

- **Publishing**: a container is created (`POST /{ig-user-id}/media`, with `image_url`, or `video_url` and `media_type=REELS`). Video containers are polled until `FINISHED`, then published (`/media_publish`). Carousels use child containers with `is_carousel_item`.
- **Comments**: list (`/{media-id}/comments`) and reply (`/{comment-id}/replies`).
- **DMs**: list conversations and send (`/{ig-user-id}/messages`).
- **Insights**: account `reach`, `views`, `accounts_engaged`, `total_interactions` and `follows_and_unfollows`. Per post: likes and comments, plus reach, saves, shares and views where the API provides them.

## Limitations

- Every post needs an image or video. Text-only posts are rejected before publishing.
- Images must be **JPEG**. Media must be at a public HTTPS URL.
- Limit of **100 API-published posts per 24 hours** per account. The rate limiter is set more conservatively.
- DM replies only within **24 hours** of the customer's last message.
- Stories and product tagging aren't implemented.

## Verification checklist

- [ ] Connect a Business account; the token refresh job succeeds after 24 hours.
- [ ] Publish an image, a Reel and a carousel.
- [ ] Receive and reply to a comment and a DM.
- [ ] Insights stored; unsupported metrics listed.
- [ ] App Review approved.

Official docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
