# LinkedIn

**Status: implemented, unverified** (`packages/social/src/adapters/linkedin.ts`), using the versioned REST APIs (`LinkedIn-Version` header).

## Developer requirements

1. An app at https://www.linkedin.com/developers/apps, linked to a LinkedIn Page that you verify.
2. The **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn** products give member posting (`w_member_social`). These are self-serve.
3. Organization pages, comments and page analytics need the **Community Management API**, which requires an application and approval (Development tier, then Standard tier). Without it, only member (personal) posting works.

## Environment

| Variable | Value |
|---|---|
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | App credentials |
| `LINKEDIN_API_VERSION` | `YYYYMM`, e.g. `202509`. LinkedIn retires versions after about a year, so keep this current |
| `LINKEDIN_ORGANIZATION_SCOPES` | `true` to also request organization scopes. Set only after Community Management API approval |

Redirect URI: `${API_URL}/api/v1/social/oauth/callback/linkedin`

## OAuth flow

1. Three-legged OAuth 2.0 via `https://www.linkedin.com/oauth/v2/authorization`.
2. Code exchanged at `/oauth/v2/accessToken`. Access tokens last about 60 days.
3. Refresh tokens are issued only to apps LinkedIn enables for programmatic refresh. Without one, the account is flagged for reconnection when the token expires.
4. `GET /v2/userinfo` (OIDC) identifies the member, who is stored as `urn:li:person:{sub}`.
5. With `rw_organization_admin`, `organizationAcls` lists administered organizations, each stored as a separate account.

## Scopes

- Member: `openid profile email w_member_social`
- Organization (after approval): `r_organization_social w_organization_social rw_organization_admin`

## Implemented

- **Posts**: `POST /rest/posts` with text, an article link or one image. Images are uploaded via `images?action=initializeUpload` followed by a PUT. The post ID is read from `x-restli-id`.
- **Comments** (Community Management): list and reply via `socialActions/{urn}/comments`.
- **Analytics** (organizations only): `organizationalEntityShareStatistics`. Member analytics are reported as unavailable.

## Limitations

- **No messaging API** for general developers. DMs are unsupported, and the UI says so.
- LinkedIn has no general webhooks, so comments are not delivered in real time. Comment polling isn't implemented yet (TODO).
- Video and multi-image posts are not implemented.

## Verification checklist

- [ ] Connect a member account and publish text, a link and an image.
- [ ] With Community Management approval: connect an organization, publish, read and reply to comments, and collect share statistics.
- [ ] Token expiry flags the account for reconnection (or refreshes it, if enabled).

Official docs: https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api · https://learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow
