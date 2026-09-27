# Deploying SocialPilot

This guide puts SocialPilot on one Linux server with Docker: automatic HTTPS, the database, Redis, the app and daily backups. A 2 vCPU / 4 GB RAM server (about $10–25 a month from Hetzner, DigitalOcean, Vultr or AWS Lightsail) handles dozens of customers.

## What you need

- A Linux server (Ubuntu 22.04 or 24.04) with a public IP address.
- A domain or subdomain, for example `app.yourcompany.com`.
- An AI API key for the default AI (Google Gemini works to start; see HOW_TO_USE.md).
- About 30 minutes.

## 1. Point the domain at the server

At your domain registrar or DNS provider, add an **A record** for `app.yourcompany.com` with the server's IP address (and an AAAA record if the server has IPv6). Wait until `ping app.yourcompany.com` shows the server's IP.

## 2. Prepare the server

```bash
ssh root@YOUR_SERVER_IP
curl -fsSL https://get.docker.com | sh           # Docker and Docker Compose
ufw allow OpenSSH && ufw allow 80 && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
```

## 3. Get the code and settings

```bash
git clone YOUR_REPOSITORY_URL socialpilot && cd socialpilot
cp env.production.example .env
nano .env
```

Fill in every value marked REQUIRED. Generate each secret with `openssl rand -base64 32` (for `POSTGRES_PASSWORD` and `REDIS_PASSWORD` use `openssl rand -hex 24` so they contain no special characters). **Save a copy of `ENCRYPTION_KEY` in your password manager**: without it, saved social tokens and API keys can't be decrypted.

## 4. Start it

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps        # all services "running" / "healthy"
```

The first build takes 5–10 minutes. Caddy gets the HTTPS certificate automatically the first time `https://app.yourcompany.com` is visited. Database migrations run when the API starts.

## 5. Create your platform admin account

Public sign-up is on by default, so:

1. Open `https://app.yourcompany.com/register` and create your own account.
2. Make it the platform admin:
   ```bash
   docker compose -f docker-compose.prod.yml exec api node apps/api/dist/admin-cli.js make-admin you@yourcompany.com
   ```
3. Sign out and back in. **Platform admin** appears in the menu.
4. In **Platform admin → Plans & billing**, turn **Public sign-up off** if you want to create every customer account yourself.

## 6. Settings in Platform admin

| Tab | What to set |
|---|---|
| **Company & legal** | Product name, company name, address, support email, governing law. Review the Terms and Privacy text (public at `/terms` and `/privacy`); have them checked for your country. |
| **Email** | Your SMTP provider (Resend, Postmark, Amazon SES, SendGrid, Brevo). Send a test email. Needed for invitations, password resets and lead alerts. |
| **Plans & billing** | Currency, trial and grace days, payment instructions, plan prices and limits. |
| **Payments** | Card payments through Stripe. Inactive until you add keys, pass **Check keys** and switch it on. Optional. |
| **Integrations** | Meta, LinkedIn and TikTok app credentials (see `docs/integrations/`). The callback and webhook URLs shown there use your domain. |

## 7. Backups

The `backup` service dumps the database and uploaded files every 24 hours into `./backups` on the server (set `BACKUP_DIR`), keeps 14 days, and checks each dump.

```bash
ls backups/                                                                   # one folder per backup
docker compose -f docker-compose.prod.yml exec backup /scripts/backup.sh once # back up now
```

**Copy backups off the server.** A backup on the same disk doesn't survive losing the server. For example, with [rclone](https://rclone.org) to any S3-compatible storage (Backblaze B2, Cloudflare R2, AWS S3), add a daily cron job:

```bash
0 4 * * * rclone sync /root/socialpilot/backups remote:socialpilot-backups
```

**Restore** (replaces the current database and uploaded files):

```bash
docker compose -f docker-compose.prod.yml stop api worker web
docker compose -f docker-compose.prod.yml exec backup /scripts/restore.sh 20261001-020000
docker compose -f docker-compose.prod.yml start api worker web
```

Test a restore once, on a spare server, before you need it.

## 8. Updating

```bash
cd socialpilot
docker compose -f docker-compose.prod.yml exec backup /scripts/backup.sh once
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

## 9. Monitoring

- `https://app.yourcompany.com/health` answers when the API is up; `/ready` also checks the database, Redis, storage and worker. Add `/ready` to a free uptime monitor (UptimeRobot, Better Stack) to get an alert when something is down.
- Logs: `docker compose -f docker-compose.prod.yml logs -f api worker`.
- **Platform admin → Queues** shows failed background jobs; **Overview** shows system health.

## How it's laid out

| Service | Role | Exposed |
|---|---|---|
| `caddy` | HTTPS (Let's Encrypt), routes `/api`, `/webhooks`, `/media` and health checks to the API and everything else to the web app | 80, 443 |
| `web` | Next.js app | internal |
| `api` | Fastify API; runs database migrations on start | internal |
| `worker` | Publishing, AI replies, webhooks, emails, reminders | internal |
| `postgres` | PostgreSQL 16 with pgvector | internal |
| `redis` | Queues and rate limits (password, AOF persistence, `noeviction`) | internal |
| `backup` | Daily database and file backups | internal |

Everything uses one domain, so `APP_URL`, `API_URL` and `WEBHOOK_BASE_URL` are all `https://DOMAIN` (set automatically by the compose file). Uploaded images are stored on the `storage` volume (`STORAGE_DRIVER=local`). To run several API servers later, switch to an S3-compatible bucket (`STORAGE_DRIVER=s3`).

## Production safety checks built in

With `NODE_ENV=production` the app refuses to start with mock social accounts, the mock AI, or local storage unless `ALLOW_LOCAL_STORAGE=true` (set by the compose file). Session cookies are `Secure`; web pages send a Content Security Policy and HSTS.

## Key rotation

1. Move the current key to `ENCRYPTION_KEY_PREVIOUS="<oldVersion>:<oldKey>"`.
2. Set a new `ENCRYPTION_KEY` and increment `ENCRYPTION_KEY_VERSION`.
3. Restart, then run `docker compose -f docker-compose.prod.yml exec api node -e "import('@socialpilot/core').then(c => c.TokenService.rotateKeys()).then(console.log)"` to re-encrypt stored tokens.
4. Remove the previous key once the rotation reports 0 remaining.

Note: platform settings secrets (SMTP password, Stripe keys) and organization AI keys are not re-encrypted by `rotateKeys`; re-enter them in Platform admin and Settings → AI models after rotating.
