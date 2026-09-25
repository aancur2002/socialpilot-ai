# Troubleshooting

**"Invalid environment configuration" at startup.** The message lists every bad variable. Common causes: `ENCRYPTION_KEY` isn't 32 bytes of base64, `JWT_SECRET` is shorter than 32 characters, or `AI_API_KEY` is missing for a non-mock provider.

**`prisma migrate dev` wants to reset the database.** It reports the pgvector HNSW index as drift. Use `npm run db:migrate` (deploy) and `npm run db:migrate:new -- <name>`, as described in [database.md](database.md).

**Install scripts skipped (npm 11 `allow-scripts` warning).** Only the packages under `allowScripts` in `package.json` run install scripts. If Prisma complains about missing engines, run `npm rebuild prisma @prisma/engines @prisma/client`.

**Ports 5432/6379 already in use.** Compose maps Postgres to 5434 and Redis to 6380. If you change them, update `DATABASE_URL` and `REDIS_URL`.

**`/ready` is `degraded` with "no worker heartbeat".** Start the worker (`npm run dev` runs it). Scheduled posts, webhooks and AI replies are processed only by the worker.

**Messages arrive but no AI suggestion appears.** Check the worker log. Also check that the client has "AI drafting" enabled, and that the message wasn't classified as spam (see the Spam filter in the inbox).

**Everything escalates with "The AI lacks the information to answer".** The knowledge base has no matching content. Add FAQs, and try the question in **Knowledge base → Test a question**. With `EMBEDDING_PROVIDER=mock`, matching is word-overlap only.

**A post failed with "media must be reachable at a public HTTPS URL".** Real platforms fetch media themselves. Configure S3 with a public or CDN `S3_PUBLIC_URL`. Mock accounts skip this check.

**Connecting a platform says "Needs server setup".** Its client ID and secret aren't set. See `docs/integrations/<platform>.md`.

**OAuth returns "This connection link has expired".** The state is single-use and lasts 10 minutes. Start the connection again, and make sure the redirect URI registered with the platform exactly matches `${API_URL}/api/v1/social/oauth/callback/<platform>`.

**Playwright can't take screenshots in a headless or container environment.** The config already passes `--disable-gpu --use-gl=swiftshader`. Also install browser dependencies with `npx playwright install --with-deps chromium`.
