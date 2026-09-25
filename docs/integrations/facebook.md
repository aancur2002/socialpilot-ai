# Facebook Pages

**Status: implemented, unverified.** The adapter code (`packages/social/src/adapters/facebook.ts`) follows the Graph API documentation known when it was written, but it hasn't been run against a real Meta app. Before production use, complete the verification checklist below and confirm details against Meta's current docs. Graph API versions and Page metrics change regularly.

## Developer requirements

1. A Meta developer account and an app of type **Business** at https://developers.facebook.com/apps.
2. The **Facebook Login for Business** product (or Facebook Login), plus **Webhooks**, and **Messenger** for Page messaging.
3. **Business verification** for the Meta business that owns the app. Advanced Access to the Page permissions requires it.
4. **App Review** for every permission below at Advanced Access, before users outside your business can connect Pages. It needs a screencast of each permission in use and a privacy policy URL.

## Environment

| Variable | Value |
|---|---|
| `FACEBOOK_CLIENT_ID` | App ID |
| `FACEBOOK_CLIENT_SECRET` | App secret. Also used to verify `X-Hub-Signature-256` on webhooks |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN` | Any random string; enter the same value in the webhook configuration |
| `META_GRAPH_API_VERSION` | e.g. `v23.0` |

Valid OAuth redirect URI (Facebook Login settings): `${API_URL}/api/v1/social/oauth/callback/facebook`

## OAuth flow

1. `https://www.facebook.com/<v>/dialog/oauth` with the scopes below and a single-use `state`.
2. The callback exchanges the code for a user token, then for a **long-lived** user token (`fb_exchange_token`).
3. `GET /me/accounts` returns one **Page access token** per managed Page. Page tokens derived from a long-lived user token don't expire. They're invalidated if the user changes their password, loses their Page role or removes the app.
4. Each Page is subscribed to the app's webhooks, then stored as a separate social account with its token encrypted.

## Scopes requested

`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_metadata`, `pages_read_user_content`, `pages_manage_engagement`, `pages_messaging`, `read_insights`, `business_management`

## Webhooks

- Callback URL: `${WEBHOOK_BASE_URL}/webhooks/facebook`. The verify token is `FACEBOOK_WEBHOOK_VERIFY_TOKEN`.
- Subscribe the **Page** object to `feed` (comments) and `messages`, plus `messaging_postbacks` if needed.
- Each connected Page is subscribed to the app automatically during connection (`POST /{page-id}/subscribed_apps` with `feed,messages,messaging_postbacks`).

## Implemented

| Capability | Endpoint |
|---|---|
| Text and link posts | `POST /{page-id}/feed` |
| Single photo | `POST /{page-id}/photos` (url + caption) |
| Multi-photo | unpublished `photos`, then `feed` with `attached_media` |
| Video | `POST /{page-id}/videos` (`file_url`) |
| Comments / replies | `GET /{post-id}/comments`, `POST /{comment-id}/comments` |
| Messenger | `GET /{page-id}/conversations`, `POST /{page-id}/messages` (`messaging_type=RESPONSE`) |
| Insights | `GET /{page-id}/insights` for `page_impressions_unique`, `page_post_engagements`, `page_follows` and `page_views_total`; per post: reactions, comments, shares. Metrics the API rejects are reported as unavailable. |
| Webhook parsing | Messenger messages and echoes, feed comments |

## Limitations

- Pages only. Personal profiles and Groups can't be published to.
- Messenger replies are allowed only within **24 hours** of the customer's last message. Outside the window, Meta rejects the send and the reply shows as failed in the inbox. Message tags aren't implemented.
- Media must be at public HTTPS URLs.
- Reels and Stories publishing isn't implemented.

## Verification checklist

- [ ] Connect a test Page with an admin test user; tokens appear encrypted in `SocialToken`.
- [ ] Publish text, one photo, multiple photos and a video; post URLs open.
- [ ] Receive a comment and a Messenger message through the webhook; the signature validates.
- [ ] Reply to both from the inbox.
- [ ] Insights collection stores snapshots; unavailable metrics are listed.
- [ ] Revoke the app on Facebook; the next call flags the account for reconnection.
- [ ] App Review approved for all scopes at Advanced Access.

Official docs: https://developers.facebook.com/docs/pages-api · https://developers.facebook.com/docs/messenger-platform · https://developers.facebook.com/docs/graph-api/webhooks
