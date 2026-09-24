import * as core from '@socialpilot/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { addMember, uid } from './helpers';

const ORIGIN = 'http://localhost:3000';

/** Minimal cookie-jar client over fastify.inject. */
function client(app: FastifyInstance) {
  let cookie = '';
  let org = '';
  const call = async (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(org ? { 'x-organization-id': org } : {}), ...extra },
    });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? (() => { try { return JSON.parse(res.body); } catch { return res.body; } })() : undefined, headers: res.headers };
  };
  return { call, setOrg: (id: string) => (org = id), cookie: () => cookie, setCookie: (c: string) => (cookie = c) };
}

describe('API end-to-end (mock integrations)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer();
  });
  afterAll(async () => {
    await app.close();
    await core.closeInfra();
  });

  it('login → client → mock account → generate → approve → schedule → publish → message → AI reply → lead', async () => {
    const api = client(app);
    const email = `e2e-${uid()}@test.local`;
    expect((await api.call('POST', '/api/v1/auth/register', { name: 'E2E', email, password: 'password-1234', organizationName: 'E2E Agency' })).status).toBe(201);
    await api.call('POST', '/api/v1/auth/logout', {});
    const login = await api.call('POST', '/api/v1/auth/login', { email, password: 'password-1234' });
    expect(login.status).toBe(200);
    const me = await api.call('GET', '/api/v1/auth/me');
    api.setOrg(me.body.organizations[0].id);

    // Create client (with brand)
    const cl = await api.call('POST', '/api/v1/clients', { name: 'Bella Bakery', timezone: 'Europe/London', brand: { brandName: 'Bella Bakery', description: 'Artisan sourdough bakery in Camden.', cta: 'Order online today' } });
    expect(cl.status).toBe(201);
    const clientId = cl.body.id;

    // Connect mock social account through the OAuth flow
    const start = await api.call('POST', '/api/v1/social/oauth/start', { clientId, platform: 'FACEBOOK', mock: true });
    expect(start.status).toBe(200);
    const consent = await app.inject({ method: 'GET', url: new URL(start.body.authorizationUrl).pathname + new URL(start.body.authorizationUrl).search });
    expect(consent.body).toContain('MOCK MODE');
    const approveHref = /href="([^"]+)"/.exec(consent.body)![1]!.replace(/&amp;/g, '&');
    const cb = await app.inject({ method: 'GET', url: new URL(approveHref).pathname + new URL(approveHref).search });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain('connected=1');
    const accounts = await api.call('GET', `/api/v1/social/accounts?clientId=${clientId}`);
    expect(accounts.body).toHaveLength(1);
    expect(accounts.body[0]).toMatchObject({ platform: 'FACEBOOK', isMock: true, status: 'ACTIVE' });
    expect(JSON.stringify(accounts.body)).not.toMatch(/mock_access_|accessTokenEnc/);
    const accountId = accounts.body[0].id;

    // Replayed OAuth callback is rejected (single-use state)
    const replay = await app.inject({ method: 'GET', url: new URL(approveHref).pathname + new URL(approveHref).search });
    expect(replay.headers.location).toContain('oauth_error');

    // Generate post with AI
    const gen = await api.call('POST', '/api/v1/content/generate', { clientId, topic: 'Autumn pumpkin sourdough launch', platforms: ['FACEBOOK'] });
    expect(gen.status).toBe(201);
    const contentId = gen.body.content.id;
    expect(gen.body.content.variants[0]).toMatchObject({ platform: 'FACEBOOK', socialAccountId: accountId });
    expect(gen.body.content.aiGenerated).toBe(true);

    // Approve
    expect((await api.call('POST', `/api/v1/content/${contentId}/submit`, {})).body.status).toBe('PENDING_APPROVAL');
    expect((await api.call('POST', `/api/v1/content/${contentId}/approve`, { decision: 'APPROVE' })).body.status).toBe('APPROVED');

    // Schedule, then publish via the worker processor
    const scheduled = await api.call('POST', `/api/v1/content/${contentId}/schedule`, { scheduledAt: new Date(Date.now() + 2000).toISOString() });
    expect(scheduled.body.status).toBe('SCHEDULED');
    const postId = scheduled.body.scheduledPosts.find((p: { status: string }) => p.status === 'SCHEDULED').id;
    const job = await core.getInfra().queues.get('publish').getJob(postId);
    expect(job).toBeTruthy();
    await new Promise((r) => setTimeout(r, 2100));
    expect(await core.executePublish(postId, 1)).toMatchObject({ status: 'published' });
    expect((await api.call('GET', `/api/v1/content/${contentId}`)).body.status).toBe('PUBLISHED');

    // Receive a message → AI reply → lead
    await api.call('POST', '/api/v1/knowledge', { clientId, type: 'FAQ', title: 'Prices', content: 'A sourdough loaf costs 4.50 pounds. We are open 8am to 6pm.' });
    const src = await core.getInfra().db.knowledgeSource.findFirstOrThrow({ where: { clientId } });
    await core.processKnowledgeSource(src.id);
    const sim = await api.call('POST', '/api/v1/dev/simulate-inbound', { socialAccountId: accountId, type: 'message', text: 'Hi! How much does a sourdough loaf cost? My email is casey@example.com' });
    expect(sim.body.received).toBe(1);
    const evt = await core.getInfra().db.webhookEvent.findFirstOrThrow({ where: { socialAccountId: accountId } });
    await core.processWebhookEvent(evt.id);
    const inboundMsg = await core.getInfra().db.message.findFirstOrThrow({ where: { conversation: { socialAccountId: accountId }, direction: 'INBOUND' } });
    const pipeline = await core.processInboundMessage(inboundMsg.id);
    expect(pipeline).toMatchObject({ decision: 'PENDING_APPROVAL', intent: 'PRICE' });

    const inbox = await api.call('GET', `/api/v1/inbox/conversations?clientId=${clientId}`);
    expect(inbox.body.items).toHaveLength(1);
    const conv = await api.call('GET', `/api/v1/inbox/conversations/${inbox.body.items[0].id}`);
    const suggestion = conv.body.suggestions[0];
    expect(suggestion.suggestedReply).toContain('4.50');
    const sent = await api.call('POST', `/api/v1/inbox/conversations/${conv.body.id}/reply`, { text: suggestion.suggestedReply, suggestionId: suggestion.id });
    expect(sent.status).toBe(201);

    const leads = await api.call('GET', `/api/v1/leads?clientId=${clientId}`);
    expect(leads.body.items).toHaveLength(1);
    expect(leads.body.items[0]).toMatchObject({ platform: 'FACEBOOK', email: 'casey@example.com', status: 'NEW' });

    // Dashboard + analytics reflect real stored data
    const dash = await api.call('GET', `/api/v1/dashboard?clientId=${clientId}`);
    expect(dash.body).toMatchObject({ publishedPosts30d: 1, newLeads: 1, connectedAccounts: 1 });
    const from = new Date(Date.now() - 7 * 86400000).toISOString();
    const to = new Date(Date.now() + 60000).toISOString();
    await core.collectAccountAnalytics(accountId, new Date(from), new Date(to));
    const overview = await api.call('GET', `/api/v1/analytics/overview?clientId=${clientId}&from=${from}&to=${to}`);
    expect(overview.body.posts.published).toBe(1);
    expect(overview.body.mockDataPresent).toBe(true);
    const report = await api.call('POST', '/api/v1/analytics/reports', { clientId, from, to });
    expect(report.status).toBe(201);
    expect(report.body.summary.caveats.join(' ')).toMatch(/simulated/i);
  });

  it('enforces RBAC, CSRF protection and session requirements over HTTP', async () => {
    const owner = client(app);
    const email = `rbac-${uid()}@test.local`;
    await owner.call('POST', '/api/v1/auth/register', { name: 'Owner', email, password: 'password-1234', organizationName: 'RBAC Org' });
    const orgId = (await owner.call('GET', '/api/v1/auth/me')).body.organizations[0].id;
    owner.setOrg(orgId);

    // No session → 401
    const anon = client(app);
    anon.setOrg(orgId);
    expect((await anon.call('GET', '/api/v1/clients')).status).toBe(401);

    // Cross-site POST with a valid cookie is blocked
    const csrf = await app.inject({ method: 'POST', url: '/api/v1/clients', payload: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json', cookie: owner.cookie(), 'x-organization-id': orgId, origin: 'https://evil.example' } });
    expect(csrf.statusCode).toBe(403);

    // Viewer cannot create content or clients
    const { user: viewer } = await addMember(orgId, 'VIEWER');
    const v = client(app);
    await core.getInfra().db.user.update({ where: { id: viewer.id }, data: { passwordHash: await (await import('@socialpilot/auth')).hashPassword('password-1234') } });
    await v.call('POST', '/api/v1/auth/login', { email: viewer.email, password: 'password-1234' });
    v.setOrg(orgId);
    expect((await v.call('POST', '/api/v1/clients', { name: 'Nope', timezone: 'UTC' })).status).toBe(403);

    // A user cannot select an organization they don't belong to
    const other = client(app);
    await other.call('POST', '/api/v1/auth/register', { name: 'Other', email: `other-${uid()}@test.local`, password: 'password-1234', organizationName: 'Other Org' });
    other.setOrg(orgId);
    expect((await other.call('GET', '/api/v1/organizations/current')).status).toBe(404);

    // Bad credentials
    expect((await client(app).call('POST', '/api/v1/auth/login', { email, password: 'wrong-password' })).status).toBe(401);

    // Validation errors are 422 with field details
    const bad = await owner.call('POST', '/api/v1/clients', { name: '' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('name');

    // Super-admin area is closed to org owners
    expect((await owner.call('GET', '/api/v1/admin/overview')).status).toBe(403);
  });

  it('verifies live webhook signatures and challenges', async () => {
    const bad = await app.inject({ method: 'POST', url: '/webhooks/facebook', payload: JSON.stringify({ object: 'page', entry: [] }), headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' } });
    expect(bad.statusCode).toBe(401);
    const { createHmac } = await import('node:crypto');
    const body = JSON.stringify({ object: 'page', entry: [] });
    const good = await app.inject({ method: 'POST', url: '/webhooks/facebook', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'fb-test-app-secret').update(body).digest('hex')}` } });
    expect(good.statusCode).toBe(200);
    const challenge = await app.inject({ method: 'GET', url: '/webhooks/facebook?hub.mode=subscribe&hub.verify_token=fb-verify&hub.challenge=42' });
    expect(challenge.body).toBe('42');
    const wrong = await app.inject({ method: 'GET', url: '/webhooks/facebook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42' });
    expect(wrong.statusCode).toBe(403);
  });

  it('exposes health and readiness endpoints', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ status: 'ok' });
    const ready = (await app.inject({ method: 'GET', url: '/ready' })).json();
    expect(ready.checks.database.ok).toBe(true);
    expect(ready.checks.redis.ok).toBe(true);
  });
});
