# WhatsApp Business Platform (Cloud API)

**Status: implemented, unverified.** Messaging only (`packages/social/src/adapters/whatsapp.ts`). WhatsApp has no feed, so there is no publishing, no comments and no analytics in this adapter.

## Developer requirements

1. A Meta app with the **WhatsApp** product, and a Meta Business portfolio.
2. **Embedded Signup** configured through Facebook Login for Business. Create a configuration and copy its ID.
3. A phone number registered to a WhatsApp Business Account (WABA), and **business verification** to lift messaging limits.
4. App Review for `whatsapp_business_management` and `whatsapp_business_messaging` if you onboard businesses you don't own. This is the Tech Provider path.

## Credentials

Enter them in **Platform admin → Integrations** (recommended: encrypted, no restart, with a credential check), or set the environment variables below. Values saved in the dashboard override the environment. The Integrations card also shows the exact redirect URI and webhook URL to copy into the developer console.


| Variable | Value |
|---|---|
| `WHATSAPP_CLIENT_ID` / `WHATSAPP_CLIENT_SECRET` | Meta app ID and secret (the secret verifies webhook signatures) |
| `WHATSAPP_CONFIG_ID` | Embedded Signup configuration ID |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Random string for webhook verification |

Redirect URI: `${API_URL}/api/v1/social/oauth/callback/whatsapp`

## Onboarding flow

1. The Facebook Login dialog with `config_id` runs Embedded Signup.
2. The code is exchanged for a business integration token.
3. `debug_token` reads the granular scopes, which list the shared WABA IDs.
4. For each WABA: `POST /{waba-id}/subscribed_apps` subscribes the app to its webhooks, and `GET /{waba-id}/phone_numbers` lists its numbers.
5. Each phone number becomes a social account (`platformAccountId` = phone number ID).

> Meta's recommended Embedded Signup uses the JavaScript SDK popup, which also returns the WABA and phone number IDs through a session message event. This server-side redirect variant is simpler but **unverified**. You may need to switch to the JS SDK flow.

## Webhooks

`${WEBHOOK_BASE_URL}/webhooks/whatsapp`. Subscribe the WABA to `messages`. Inbound messages create conversations keyed by `phone_number_id:wa_id`. Delivery `statuses` of `failed` mark our outbound message as failed.

## Implemented

- Send text replies: `POST /{phone-number-id}/messages` (`messaging_product: whatsapp`).
- Receive text, button, interactive and media messages. Non-text media is stored as a type-only attachment; media download isn't implemented.

## Limitations

- **24-hour customer service window.** Free-form replies are accepted only within 24 hours of the customer's last message. After that, only pre-approved **template messages** may be sent. **Templates aren't implemented**, so replies outside the window fail with Meta's error, shown in the inbox.
- There's no API to fetch message history. Conversations start from the first webhook received after connecting.
- Pricing is per conversation or message and is charged by Meta.

## Verification checklist

- [ ] Embedded Signup completes and phone numbers appear as accounts.
- [ ] An inbound message creates a conversation, with a valid signature.
- [ ] A reply is delivered within the 24-hour window.
- [ ] A reply outside the window fails with a clear error.

Official docs: https://developers.facebook.com/docs/whatsapp/cloud-api · https://developers.facebook.com/docs/whatsapp/embedded-signup
