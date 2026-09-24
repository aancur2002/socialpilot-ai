import * as core from '@socialpilot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createClientWithMock, createOwner, drainInbound } from './helpers';

describe('multi-tenant isolation', () => {
  let a: Awaited<ReturnType<typeof createOwner>>;
  let b: Awaited<ReturnType<typeof createOwner>>;
  let clientA: Awaited<ReturnType<typeof createClientWithMock>>;
  let clientA2: Awaited<ReturnType<typeof createClientWithMock>>;
  let clientB: Awaited<ReturnType<typeof createClientWithMock>>;

  beforeAll(async () => {
    a = await createOwner('A');
    b = await createOwner('B');
    await core.getInfra().db.organization.updateMany({ where: { id: { in: [a.organizationId, b.organizationId] } }, data: { plan: 'AGENCY' } });
    clientA = await createClientWithMock(a.ctx);
    clientA2 = await createClientWithMock(a.ctx);
    clientB = await createClientWithMock(b.ctx);
  });

  afterAll(async () => core.closeInfra());

  it('an organization cannot read another organization’s client', async () => {
    await expect(core.getClient(a.ctx, clientB.client.id)).rejects.toMatchObject({ status: 404 });
    const list = await core.listClients(a.ctx);
    expect(list.map((c) => c.id)).not.toContain(clientB.client.id);
  });

  it('returns nothing when another tenant’s client id is used as a filter', async () => {
    // Queries are always constrained to the caller's organization, so a foreign id matches no rows.
    expect((await core.listContent(a.ctx, { clientId: clientB.client.id, limit: 10 })).items).toEqual([]);
    expect(await core.listSocialAccounts(a.ctx, clientB.client.id)).toEqual([]);
    expect((await core.listConversations(a.ctx, { clientId: clientB.client.id, limit: 10 })).items).toEqual([]);
  });

  it('cannot read or modify another tenant’s content, conversation or social account', async () => {
    const content = await core.createContent(b.ctx, { clientId: clientB.client.id, title: 'B post', contentType: 'POST', baseContent: 'x', variants: [] });
    await expect(core.getContent(a.ctx, content.id)).rejects.toMatchObject({ status: 404 });
    await expect(core.deleteContent(a.ctx, content.id)).rejects.toMatchObject({ status: 404 });
    await expect(core.disconnectSocialAccount(a.ctx, clientB.accounts.FACEBOOK!.id)).rejects.toMatchObject({ status: 404 });

    await core.simulateInbound(b.ctx, { socialAccountId: clientB.accounts.FACEBOOK!.id, type: 'message', text: 'Hello there?' });
    await drainInbound(clientB.accounts.FACEBOOK!.id);
    const convB = (await core.listConversations(b.ctx, { limit: 10 })).items[0]!;
    await expect(core.getConversation(a.ctx, convB.id)).rejects.toMatchObject({ status: 404 });
    await expect(core.replyToConversation(a.ctx, convB.id, { text: 'hijack' })).rejects.toMatchObject({ status: 404 });
    expect((await core.listConversations(a.ctx, { limit: 50 })).items.map((c) => c.id)).not.toContain(convB.id);
  });

  it('cannot attach another tenant’s social account or media to content', async () => {
    await expect(
      core.createContent(a.ctx, { clientId: clientA.client.id, title: 't', contentType: 'POST', baseContent: 'x', variants: [{ platform: 'FACEBOOK', socialAccountId: clientB.accounts.FACEBOOK!.id, caption: 'x', hashtags: [] }] }),
    ).rejects.toMatchObject({ status: 400 });
    // A sibling client's account inside the same org is also rejected.
    await expect(
      core.createContent(a.ctx, { clientId: clientA.client.id, title: 't', contentType: 'POST', baseContent: 'x', variants: [{ platform: 'FACEBOOK', socialAccountId: clientA2.accounts.FACEBOOK!.id, caption: 'x', hashtags: [] }] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('restricts CLIENT-role members to their assigned client', async () => {
    const { ctx } = await addMember(a.organizationId, 'CLIENT', [clientA.client.id]);
    expect((await core.listClients(ctx)).map((c) => c.id)).toEqual([clientA.client.id]);
    await expect(core.getClient(ctx, clientA2.client.id)).rejects.toMatchObject({ status: 404 });
    await expect(core.createContent(ctx, { clientId: clientA.client.id, title: 't', contentType: 'POST', baseContent: 'x', variants: [] })).rejects.toMatchObject({ status: 403 });
  });

  it('never retrieves knowledge from another client', async () => {
    const secret = 'The secret staff discount code is ZEBRA-4471 for sourdough loaves';
    const src = await core.createKnowledgeSource(a.ctx, { clientId: clientA2.client.id, type: 'MANUAL', title: 'Internal', content: secret });
    await core.processKnowledgeSource(src.id);
    const own = await core.searchKnowledgeInternal(a.organizationId, clientA2.client.id, 'staff discount code sourdough', 5, 0);
    expect(own.some((h) => h.content.includes('ZEBRA'))).toBe(true);
    const sibling = await core.searchKnowledgeInternal(a.organizationId, clientA.client.id, 'staff discount code sourdough', 5, 0);
    expect(sibling.some((h) => h.content.includes('ZEBRA'))).toBe(false);
    const otherOrg = await core.searchKnowledgeInternal(b.organizationId, clientA2.client.id, 'staff discount code sourdough', 5, 0);
    expect(otherOrg).toEqual([]);
  });

  it('stores OAuth tokens encrypted and never returns them', async () => {
    const { db } = core.getInfra();
    const token = await db.socialToken.findUniqueOrThrow({ where: { socialAccountId: clientA.accounts.FACEBOOK!.id } });
    expect(token.accessTokenEnc).toMatch(/^v1:/);
    expect(token.accessTokenEnc).not.toContain('mock_access_');
    expect(core.TokenService.decode(token).accessToken).toMatch(/^mock_access_/);
    const pub = await core.getSocialAccount(a.ctx, clientA.accounts.FACEBOOK!.id);
    expect(JSON.stringify(pub)).not.toMatch(/mock_access_|accessTokenEnc|refreshToken/);
  });

  it('lets only members who see all clients manage org-wide automation rules', async () => {
    const { ctx } = await addMember(a.organizationId, 'MANAGER', [clientA.client.id]);
    await expect(core.createAutomationRule(ctx, { name: 'r', trigger: 'MESSAGE_RECEIVED', enabled: true, priority: 1, platforms: [], conditions: [], actions: [{ type: 'notify' }], stopProcessing: false })).rejects.toMatchObject({ status: 400 });
    await expect(core.createAutomationRule(ctx, { clientId: clientA.client.id, name: 'r', trigger: 'MESSAGE_RECEIVED', enabled: true, priority: 1, platforms: [], conditions: [], actions: [{ type: 'notify' }], stopProcessing: false })).resolves.toBeTruthy();
  });

  it('prevents role escalation through member management', async () => {
    const { ctx: admin } = await addMember(a.organizationId, 'ORG_ADMIN');
    const { user } = await addMember(a.organizationId, 'VIEWER');
    const member = await core.getInfra().db.organizationMember.findFirstOrThrow({ where: { userId: user.id } });
    await expect(core.updateMember(admin, member.id, { role: 'ORG_OWNER' })).rejects.toMatchObject({ status: 403 });
    await expect(core.updateMember(admin, member.id, { role: 'MANAGER' })).resolves.toMatchObject({ role: 'MANAGER' });
  });
});
