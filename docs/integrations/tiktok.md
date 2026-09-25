# TikTok

**Status: implemented, unverified.** Login Kit and the Content Posting API, direct post (`packages/social/src/adapters/tiktok.ts`).

## Developer requirements

1. An app at https://developers.tiktok.com with the **Login Kit** and **Content Posting API** products, with Direct Post enabled.
2. **Domain or URL-prefix verification** for every domain media is pulled from (`PULL_FROM_URL`). This is typically your S3 or CDN domain from `S3_PUBLIC_URL`.
3. **App audit.** Until TikTok audits the app, direct posts are restricted to **private (`SELF_ONLY`) visibility**, and only a limited number of users can authorize it. The adapter reads the privacy levels TikTok allows for each creator and uses the most public one available.
4. TikTok's content-sharing guidelines require specific UX before posting: showing the creator's nickname, letting them choose privacy, and interaction toggles. **Our UI doesn't implement that consent screen yet** (TODO). Build it before applying for the audit.

## Credentials

Enter them in **Platform admin → Integrations** (recommended: encrypted, no restart, with a credential check), or set the environment variables below. Values saved in the dashboard override the environment. The Integrations card also shows the exact redirect URI and webhook URL to copy into the developer console.


| Variable | Value |
|---|---|
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | App credentials |

Redirect URI: `${API_URL}/api/v1/social/oauth/callback/tiktok`

## OAuth flow

1. `https://www.tiktok.com/v2/auth/authorize/`
2. `POST https://open.tiktokapis.com/v2/oauth/token/` returns an access token (about 24 hours) and a refresh token (about 365 days).
3. The maintenance job refreshes access tokens before they expire.
4. Revocation uses `/v2/oauth/revoke/`.

## Scopes

`user.info.basic`, `user.info.profile`, `user.info.stats`, `video.publish`, `video.upload`, `video.list`

## Implemented

- **Video**: `post/publish/creator_info/query/`, then `post/publish/video/init/` (`PULL_FROM_URL`), then `post/publish/status/fetch/` is polled until `PUBLISH_COMPLETE` or `FAILED`.
- **Photo posts**: `post/publish/content/init/` with `media_type=PHOTO`.
- **Analytics**: follower count, and per-video views, likes, comments and shares (`video/query/`). Reach, impressions, saves and clicks are reported as unavailable.

## Limitations

- Every post needs media; text-only posts aren't allowed.
- **No comments or DM APIs** for general developers. TikTok conversations don't appear in the inbox.
- There are no content webhooks in this integration. Publish status is polled for up to about 5 minutes; if still processing, the post is marked failed with "status unknown" rather than retried, to avoid duplicates.
- Posting-frequency limits are enforced by TikTok (`spam_risk_too_many_posts`).

## Verification checklist

- [ ] Verify the media domain and connect a sandbox or test user.
- [ ] Publish a video and a photo post (private while unaudited).
- [ ] Token refresh succeeds after about 24 hours.
- [ ] Video stats collected.
- [ ] Consent UX implemented and the app audit passed.

Official docs: https://developers.tiktok.com/doc/content-posting-api-get-started · https://developers.tiktok.com/doc/login-kit-web
