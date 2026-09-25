import * as core from '@socialpilot/core';
import { platformSchema, startOAuthSchema, connectMockSchema, PLATFORMS } from '@socialpilot/validation';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { doc, idParam, noContent, parse, requireCtx } from '../http';

const platformParam = z.object({ platform: z.string().transform((p) => p.toUpperCase()).pipe(platformSchema) });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function socialRoutes(app: FastifyInstance) {
  app.get('/social/platforms', { schema: { tags: ['social'] } }, async (req) => {
    await requireCtx(req);
    return core.platformStatuses();
  });

  app.get('/social/accounts', { schema: { tags: ['social'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional() }), req.query);
    return core.listSocialAccounts(await requireCtx(req), q.clientId);
  });

  app.get('/social/accounts/:id', { schema: { tags: ['social'] } }, async (req) => core.getSocialAccount(await requireCtx(req), parse(idParam, req.params).id));

  app.delete('/social/accounts/:id', { schema: { tags: ['social'] } }, async (req, reply) => {
    await core.disconnectSocialAccount(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });

  app.post('/social/accounts/:id/refresh', { schema: { tags: ['social'] } }, async (req) => core.refreshSocialProfile(await requireCtx(req), parse(idParam, req.params).id));

  app.post('/social/oauth/start', { schema: { tags: ['social'], body: doc(startOAuthSchema) } }, async (req) => {
    const body = parse(startOAuthSchema.extend({ mock: z.boolean().optional() }), req.body);
    return core.startOAuth(await requireCtx(req), body);
  });

  app.get('/social/oauth/callback/:platform', { schema: { tags: ['social'] } }, async (req, reply) => {
    const { platform } = parse(platformParam, req.params);
    const q = parse(z.object({ state: z.string().max(200).optional(), code: z.string().max(4000).optional(), error: z.string().max(500).optional(), error_description: z.string().max(1000).optional() }), req.query);
    return reply.redirect(await core.completeOAuth(platform, q));
  });

  /** Development-only consent screen for Mock* providers. */
  app.get('/social/oauth/mock/authorize', { schema: { hide: true } }, async (req, reply) => {
    if (!core.getInfra().social.mockEnabled) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Mock mode is disabled' } });
    const q = parse(z.object({ platform: z.enum(PLATFORMS), state: z.string().min(10).max(200), redirect_uri: z.string().url() }), req.query);
    // Only ever redirect back to our own callback — never an arbitrary URL.
    if (q.redirect_uri !== core.oauthRedirectUri(q.platform)) return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Unexpected redirect_uri' } });
    const approve = new URL(q.redirect_uri);
    approve.searchParams.set('code', `mock_code_${q.platform}_${q.state.slice(0, 8)}`);
    approve.searchParams.set('state', q.state);
    const deny = new URL(q.redirect_uri);
    deny.searchParams.set('error', 'access_denied');
    deny.searchParams.set('state', q.state);
    return reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock ${escapeHtml(q.platform)} authorization</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#1e293b;padding:32px;border-radius:16px;max-width:420px;width:calc(100% - 32px)}.tag{display:inline-block;background:#f59e0b;color:#111;font-weight:700;padding:2px 8px;border-radius:6px;font-size:12px}a{display:inline-block;margin-top:16px;margin-right:8px;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600}.ok{background:#6366f1;color:#fff}.no{background:#334155;color:#e2e8f0}</style></head>
<body><main><span class="tag">MOCK MODE</span><h1>Connect Mock${escapeHtml(q.platform.charAt(0) + q.platform.slice(1).toLowerCase())}</h1><p>This is a simulated consent screen for development. No real ${escapeHtml(q.platform)} account is connected and nothing will be posted to ${escapeHtml(q.platform)}.</p>
<a class="ok" href="${escapeHtml(approve.toString())}">Authorize mock account</a><a class="no" href="${escapeHtml(deny.toString())}">Cancel</a></main></body></html>`);
  });

  app.post('/social/accounts/mock', { schema: { tags: ['social'], body: doc(connectMockSchema) } }, async (req, reply) =>
    reply.status(201).send(await core.connectMockAccount(await requireCtx(req), parse(connectMockSchema, req.body))),
  );

  app.post('/dev/simulate-inbound', { schema: { tags: ['dev'] } }, async (req) => {
    const body = parse(
      z.object({ socialAccountId: z.string().min(1).max(64), type: z.enum(['message', 'comment']), text: z.string().trim().min(1).max(2000), fromName: z.string().max(100).optional(), fromId: z.string().max(100).optional(), postId: z.string().max(200).optional() }),
      req.body,
    );
    return core.simulateInbound(await requireCtx(req), body);
  });
}

export async function webhookRoutes(app: FastifyInstance) {
  const handle = (mock: boolean) => ({
    challenge: async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      const { platform } = parse(platformParam, req.params);
      const answer = await core.answerWebhookChallenge(platform, req.query as Record<string, string | undefined>, mock);
      if (answer === null) return reply.status(403).send('Verification failed');
      return reply.type('text/plain').send(answer);
    },
    receive: async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      const { platform } = parse(platformParam, req.params);
      const receipt = await core.receiveWebhook(platform, { rawBody: req.rawBody ?? Buffer.from(''), headers: req.headers, query: req.query as Record<string, string | undefined> }, mock);
      return reply.status(200).send(receipt);
    },
  });
  const live = handle(false);
  const mock = handle(true);
  const limits = { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } }, schema: { tags: ['webhooks'] } };
  app.get('/webhooks/mock/:platform', limits, mock.challenge);
  app.post('/webhooks/mock/:platform', limits, async (req, reply) => {
    if (!core.getInfra().social.mockEnabled) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Mock mode is disabled' } });
    return mock.receive(req, reply);
  });
  app.get('/webhooks/:platform', limits, live.challenge);
  app.post('/webhooks/:platform', limits, live.receive);
}
