import * as core from '@socialpilot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createClientWithMock, createOwner } from './helpers';

describe('account, knowledge editing and AI model settings', () => {
  let owner: Awaited<ReturnType<typeof createOwner>>;
  let other: Awaited<ReturnType<typeof createOwner>>;
  let setup: Awaited<ReturnType<typeof createClientWithMock>>;
  const { db } = core.getInfra();

  beforeAll(async () => {
    owner = await createOwner('Settings');
    other = await createOwner('Other');
    setup = await createClientWithMock(owner.ctx);
  });
  afterAll(async () => core.closeInfra());

  describe('password change', () => {
    it('rejects a wrong current password and keeps the old one', async () => {
      const session = await core.login({ email: owner.email, password: 'password-1234' }, {});
      const user = (await core.validateSession(session.token))!;
      await expect(core.changePassword(user.id, user.sessionId, { currentPassword: 'wrong-password', newPassword: 'brand-new-pass-1' }, {})).rejects.toMatchObject({ status: 422 });
      await expect(core.login({ email: owner.email, password: 'password-1234' }, {})).resolves.toBeTruthy();
    });

    it('changes the password and signs out other sessions only', async () => {
      const current = await core.login({ email: owner.email, password: 'password-1234' }, {});
      const elsewhere = await core.login({ email: owner.email, password: 'password-1234' }, {});
      const user = (await core.validateSession(current.token))!;
      const res = await core.changePassword(user.id, user.sessionId, { currentPassword: 'password-1234', newPassword: 'brand-new-pass-1' }, {});
      expect(res.otherSessionsSignedOut).toBeGreaterThan(0);
      expect(await core.validateSession(current.token)).not.toBeNull();
      expect(await core.validateSession(elsewhere.token)).toBeNull();
      await expect(core.login({ email: owner.email, password: 'password-1234' }, {})).rejects.toMatchObject({ status: 401 });
      await expect(core.login({ email: owner.email, password: 'brand-new-pass-1' }, {})).resolves.toBeTruthy();
    });

    it('updates the display name', async () => {
      expect((await core.updateProfile(owner.user.id, { name: 'Renamed Owner' })).name).toBe('Renamed Owner');
    });
  });

  describe('knowledge editing', () => {
    it('edits text, re-indexes, and search reflects the change', async () => {
      const src = await core.createKnowledgeSource(owner.ctx, { clientId: setup.client.id, type: 'FAQ', title: 'Hours', content: 'We open at 9am on weekdays.' });
      await core.processKnowledgeSource(src.id);
      const edited = await core.updateKnowledgeSource(owner.ctx, src.id, { content: 'We open at 7am on weekdays and 10am on Sundays.' });
      expect(edited.status).toBe('PENDING');
      await core.processKnowledgeSource(src.id);
      const hits = await core.searchKnowledgeInternal(owner.organizationId, setup.client.id, 'open Sundays', 5);
      expect(hits.some((h) => h.content.includes('10am on Sundays'))).toBe(true);
      expect(hits.some((h) => h.content.includes('9am'))).toBe(false);
    });

    it('turns an edited document into text-backed knowledge', async () => {
      const media = await core.uploadMedia(owner.ctx, { clientId: setup.client.id, fileName: 'faq.txt', declaredMime: 'text/plain', data: Buffer.from('Parking is free after 6pm.'), purpose: 'knowledge' });
      const src = await core.createKnowledgeSource(owner.ctx, { clientId: setup.client.id, type: 'DOCUMENT', title: 'Parking', mediaId: media.id });
      await core.processKnowledgeSource(src.id);
      expect((await core.getKnowledgeSource(owner.ctx, src.id)).content).toContain('Parking is free');
      await core.updateKnowledgeSource(owner.ctx, src.id, { content: 'Parking is free after 5pm.' });
      const after = await db.knowledgeSource.findUniqueOrThrow({ where: { id: src.id } });
      expect(after).toMatchObject({ mediaId: null, content: 'Parking is free after 5pm.' });
    });

    it('does not let another organization or a viewer edit knowledge', async () => {
      const src = await core.createKnowledgeSource(owner.ctx, { clientId: setup.client.id, type: 'FAQ', title: 'Private', content: 'Internal fact.' });
      await expect(core.updateKnowledgeSource(other.ctx, src.id, { title: 'hijacked' })).rejects.toMatchObject({ status: 404 });
      const { ctx: viewer } = await addMember(owner.organizationId, 'VIEWER');
      await expect(core.updateKnowledgeSource(viewer, src.id, { title: 'nope' })).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('AI model settings', () => {
    it('saves settings, encrypts the key and only returns a hint', async () => {
      const saved = await core.updateAiSettings(owner.ctx, { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant-test-key-1234' });
      expect(saved.saved).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: { set: true, hint: '…1234' } });
      expect(saved.effective).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', apiKeySource: 'organization' });
      expect(JSON.stringify(saved)).not.toContain('sk-ant-test-key');
      const row = await db.organizationAiSettings.findUniqueOrThrow({ where: { organizationId: owner.organizationId } });
      expect(row.apiKeyEnc).toMatch(/^v1:/);
      expect(row.apiKeyEnc).not.toContain('sk-ant');
      const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: owner.organizationId, action: 'ai.settings_changed' } });
      expect(JSON.stringify(audit)).not.toContain('sk-ant-test-key');
    });

    it('uses organization settings for that organization only', async () => {
      core.clearAiCache();
      expect((await core.aiFor(owner.organizationId)).ai.name).toBe('anthropic');
      expect((await core.aiFor(owner.organizationId)).ai.modelFor('default')).toBe('claude-sonnet-5');
      expect((await core.aiFor(other.organizationId)).ai.name).toBe('mock'); // server default
    });

    it('requires an API key for a real provider and keeps the stored key when omitted', async () => {
      await expect(core.updateAiSettings(owner.ctx, { apiKey: null })).rejects.toMatchObject({ status: 400 });
      const kept = await core.updateAiSettings(owner.ctx, { fastModel: 'claude-haiku-4-5' });
      expect(kept.saved.apiKey.set).toBe(true);
      expect(kept.effective.fastModel).toBe('claude-haiku-4-5');
    });

    it('flags a re-index when the embedding model changes and resets to defaults', async () => {
      const res = await core.updateAiSettings(owner.ctx, { provider: null, model: null, fastModel: null, apiKey: null, embeddingProvider: 'mock' });
      expect(res.effective.provider).toBe('mock');
      expect(res.saved.apiKey.set).toBe(false);
      expect(res.reindexRequired).toBe(false);
    });

    it('tests a configuration without saving it', async () => {
      const ok = await core.testAiSettings(owner.ctx, { provider: 'mock' });
      expect(ok.text).toMatchObject({ ok: true });
      expect(ok.embeddings).toMatchObject({ ok: true, dimensions: 1536 });
      const missingKey = await core.testAiSettings(owner.ctx, { provider: 'openai', apiKey: null });
      expect(missingKey.text).toMatchObject({ ok: false, error: expect.stringMatching(/API key/) });
    });

    it('supports Google Gemini and NVIDIA, reusing one key for text and embeddings', async () => {
      const g = await core.updateAiSettings(owner.ctx, { provider: 'google', model: null, fastModel: null, apiKey: 'AIza-test-key-5678', embeddingProvider: 'google', embeddingModel: null });
      expect(g.effective).toMatchObject({ provider: 'google', model: 'gemini-3.8-flash', fastModel: 'gemini-3.1-flash-lite', embeddingProvider: 'google', embeddingModel: 'gemini-embedding-001', apiKeySource: 'organization' });
      expect(g.suggestions.google.length).toBeGreaterThan(0);
      const n = await core.updateAiSettings(owner.ctx, { provider: 'nvidia', apiKey: 'nvapi-test-key-0000', model: 'deepseek-ai/deepseek-r1', embeddingProvider: 'nvidia' });
      expect(n.effective).toMatchObject({ provider: 'nvidia', model: 'deepseek-ai/deepseek-r1', embeddingModel: 'nvidia/nv-embedqa-e5-v5' });
      expect(n.reindexRequired).toBe(true);
      core.clearAiCache(owner.organizationId);
      expect((await core.aiFor(owner.organizationId)).ai.name).toBe('nvidia');
      // Different embedding service without its own key is rejected.
      await expect(core.updateAiSettings(owner.ctx, { embeddingProvider: 'openai' })).rejects.toMatchObject({ status: 400 });
      await core.updateAiSettings(owner.ctx, { provider: null, model: null, fastModel: null, apiKey: null, embeddingProvider: null, embeddingModel: null });
    });

    it('saves backup providers with their own encrypted keys and builds a failover chain', async () => {
      const res = await core.updateAiSettings(owner.ctx, {
        provider: 'google',
        apiKey: 'AIza-primary-key-1111',
        embeddingProvider: 'mock',
        fallbacks: [{ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', apiKey: 'nvapi-backup-key-2222' }],
      });
      expect(res.saved.fallbacks).toEqual([{ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', fastModel: null, apiKey: { set: true, hint: '…2222' } }]);
      expect(res.effective.chain.map((c) => c.provider)).toEqual(['google', 'nvidia']);
      expect(JSON.stringify(res)).not.toMatch(/nvapi-backup|AIza-primary/);
      const row = await db.organizationAiSettings.findUniqueOrThrow({ where: { organizationId: owner.organizationId } });
      expect(JSON.stringify(row.fallbacks)).not.toContain('nvapi-backup');
      core.clearAiCache(owner.organizationId);
      const { ai } = await core.aiFor(owner.organizationId);
      expect(ai.constructor.name).toBe('FailoverAIProvider');

      // Omitting a backup's key keeps the saved one; reordering keeps it too.
      const kept = await core.updateAiSettings(owner.ctx, { fallbacks: [{ provider: 'nvidia', model: 'deepseek-ai/deepseek-r1' }] });
      expect(kept.saved.fallbacks[0]).toMatchObject({ model: 'deepseek-ai/deepseek-r1', apiKey: { set: true, hint: '…2222' } });

      // One key serves embeddings when the embedding service matches a backup.
      const emb = await core.updateAiSettings(owner.ctx, { embeddingProvider: 'nvidia' });
      expect(emb.effective.embeddingProvider).toBe('nvidia');
    });

    it('rejects duplicate providers and backups without a key', async () => {
      await expect(core.updateAiSettings(owner.ctx, { fallbacks: [{ provider: 'google' }] })).rejects.toMatchObject({ status: 400 });
      await expect(core.updateAiSettings(owner.ctx, { fallbacks: [{ provider: 'openai' }] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/openai backup/) });
    });

    it('tests each provider in the chain independently', async () => {
      const res = await core.testAiSettings(owner.ctx, { provider: 'mock', embeddingProvider: 'mock', fallbacks: [{ provider: 'openai', apiKey: null }] });
      expect(res.chain).toHaveLength(2);
      expect(res.chain[0]).toMatchObject({ provider: 'mock', role: 'primary', ok: true });
      expect(res.chain[1]).toMatchObject({ provider: 'openai', role: 'backup', ok: false, error: expect.stringMatching(/API key/) });
      await core.updateAiSettings(owner.ctx, { provider: null, apiKey: null, embeddingProvider: null, fallbacks: [] });
    });

    it('is restricted to members who can manage settings', async () => {
      const { ctx: manager } = await addMember(owner.organizationId, 'MANAGER');
      await expect(core.getAiSettings(manager)).rejects.toMatchObject({ status: 403 });
      await expect(core.updateAiSettings(manager, { provider: 'mock' })).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('platform app credentials (platform admins)', () => {
    const admin = { id: 'platform-admin', isSuperAdmin: true };

    it('only lets super admins manage credentials', async () => {
      await expect(core.listPlatformSetup({ isSuperAdmin: false })).rejects.toMatchObject({ status: 403 });
    });

    it('saves encrypted credentials that take effect without a restart', async () => {
      const before = await core.listPlatformSetup(admin);
      expect(before.platforms.find((p) => p.platform === 'TIKTOK')!.configured).toBe(false);
      const after = await core.savePlatformSetup({ ...admin, id: owner.user.id }, 'TIKTOK', { clientId: 'tt-client-key', clientSecret: 'tt-secret-9876' });
      const tiktok = after.platforms.find((p) => p.platform === 'TIKTOK')!;
      expect(tiktok).toMatchObject({ configured: true, clientId: { value: 'tt-client-key', source: 'dashboard' }, clientSecret: { set: true, hint: '…9876', source: 'dashboard' } });
      expect(JSON.stringify(after)).not.toContain('tt-secret-9876');
      const row = await db.platformCredential.findUniqueOrThrow({ where: { platform: 'TIKTOK' } });
      expect(row.clientSecretEnc).toMatch(/^v1:/);
      expect((await core.getSocial()).realAdapter('TIKTOK').isConfigured()).toBe(true);
      expect((await core.platformStatuses()).platforms.find((p) => p.platform === 'TIKTOK')!.configured).toBe(true);
    });

    it('keeps environment values where the dashboard has none, and removes saved values', async () => {
      const fb = (await core.listPlatformSetup(admin)).platforms.find((p) => p.platform === 'FACEBOOK')!;
      expect(fb.clientId.source).toBe('env'); // set in the test environment
      const cleared = await core.savePlatformSetup({ ...admin, id: owner.user.id }, 'TIKTOK', { clientId: null, clientSecret: null });
      expect(cleared.platforms.find((p) => p.platform === 'TIKTOK')!.configured).toBe(false);
    });

    it('reports honestly when a platform cannot verify credentials', async () => {
      await core.savePlatformSetup({ ...admin, id: owner.user.id }, 'LINKEDIN', { clientId: 'li-id', clientSecret: 'li-secret-1' });
      expect(await core.checkPlatformSetup(admin, 'LINKEDIN')).toMatchObject({ ok: null });
      expect(await core.checkPlatformSetup(admin, 'TIKTOK')).toMatchObject({ ok: false, message: expect.stringMatching(/missing/) });
    });

    it('replaces a mock account with a real one and moves pending work', async () => {
      const mock = setup.accounts.FACEBOOK!;
      const replacement = await core.connectMockAccount(owner.ctx, { clientId: setup.client.id, platform: 'FACEBOOK', displayName: 'Stand-in for the real page' });
      const content = await core.createContent(owner.ctx, { clientId: setup.client.id, title: 'Move me', contentType: 'POST', baseContent: 'x', variants: [{ platform: 'FACEBOOK', socialAccountId: mock.id, caption: 'hello', hashtags: [] }] });
      await core.submitForApproval(owner.ctx, content.id);
      await core.decideApproval(owner.ctx, content.id, { decision: 'APPROVE' });
      await core.scheduleContent(owner.ctx, content.id, { scheduledAt: new Date(Date.now() + 3600_000) });
      // The replacement must be a real account; real OAuth isn't available in tests, so mark it real.
      await db.socialAccount.update({ where: { id: replacement.id }, data: { isMock: false } });
      const moved = await core.replaceMockAccount(owner.ctx, mock.id, replacement.id);
      expect(moved).toMatchObject({ variants: 1, scheduledPosts: 1 });
      const after = await core.getContent(owner.ctx, content.id);
      expect(after.variants[0]!.socialAccountId).toBe(replacement.id);
      expect(after.scheduledPosts.find((p) => p.status === 'SCHEDULED')!.socialAccountId).toBe(replacement.id);
      expect((await db.socialAccount.findUniqueOrThrow({ where: { id: mock.id } })).status).toBe('DISCONNECTED');
      await expect(core.replaceMockAccount(owner.ctx, replacement.id, mock.id)).rejects.toMatchObject({ status: 400 });
    });
  });
});
