import { randomUUID } from 'node:crypto';
import type { RoleKey } from '@socialpilot/auth';
import * as core from '@socialpilot/core';

export const uid = () => randomUUID().slice(0, 8);

export async function createOwner(label = 'Org') {
  const email = `owner-${uid()}@test.local`;
  const res = await core.register({ name: `${label} Owner`, email, password: 'password-1234', organizationName: `${label} ${uid()}` }, {});
  const user = { id: res.user.id, isSuperAdmin: false };
  const ctx = await core.resolveAuthContext(user, res.organizationId!);
  return { user: res.user, organizationId: res.organizationId!, ctx, email };
}

export async function addMember(organizationId: string, role: RoleKey, clientIds: string[] = [], clientAccess: 'ALL' | 'ASSIGNED' = clientIds.length ? 'ASSIGNED' : 'ALL') {
  const { db } = core.getInfra();
  const user = await db.user.create({ data: { email: `${role.toLowerCase()}-${uid()}@test.local`, name: role } });
  const member = await db.organizationMember.create({ data: { organizationId, userId: user.id, role, clientAccess } });
  if (clientIds.length) await db.clientMember.createMany({ data: clientIds.map((clientId) => ({ memberId: member.id, clientId })) });
  const ctx = await core.resolveAuthContext({ id: user.id, isSuperAdmin: false }, organizationId);
  return { user, ctx };
}

export async function createClientWithMock(ctx: core.AuthContext, platforms: ('FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN' | 'TIKTOK' | 'WHATSAPP')[] = ['FACEBOOK']) {
  const client = await core.createClient(ctx, {
    name: `Client ${uid()}`,
    timezone: 'UTC',
    brand: { brandName: 'Bella Bakery', description: 'Artisan sourdough bakery.', website: 'https://bella.example', cta: 'Order online' },
  });
  const accounts: Record<string, Awaited<ReturnType<typeof core.connectMockAccount>>> = {};
  for (const p of platforms) accounts[p] = await core.connectMockAccount(ctx, { clientId: client.id, platform: p });
  return { client, accounts };
}

/** Runs the queued webhook → ingest → AI pipeline inline (no worker needed in tests). */
export async function drainInbound(socialAccountId: string) {
  const { db } = core.getInfra();
  const events = await db.webhookEvent.findMany({ where: { socialAccountId, status: 'RECEIVED' } });
  for (const e of events) await core.processWebhookEvent(e.id);
  const pending = await db.message.findMany({ where: { conversation: { socialAccountId }, direction: 'INBOUND' }, orderBy: { createdAt: 'asc' } });
  const results = [];
  for (const m of pending) results.push(await core.processInboundMessage(m.id));
  return results;
}

export async function createApprovedContent(ctx: core.AuthContext, clientId: string, variants: { platform: 'FACEBOOK' | 'LINKEDIN'; socialAccountId: string; caption: string }[]) {
  const content = await core.createContent(ctx, {
    clientId,
    title: `Post ${uid()}`,
    contentType: 'POST',
    baseContent: 'Base idea',
    variants: variants.map((v) => ({ ...v, hashtags: [] })),
  });
  await core.submitForApproval(ctx, content.id);
  return core.decideApproval(ctx, content.id, { decision: 'APPROVE' });
}
