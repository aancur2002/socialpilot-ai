import * as core from '@socialpilot/core';
import { MOCK_FAILURE_MARKERS } from '@socialpilot/social';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApprovedContent, createClientWithMock, createOwner } from './helpers';

describe('publishing engine', () => {
  let owner: Awaited<ReturnType<typeof createOwner>>;
  let setup: Awaited<ReturnType<typeof createClientWithMock>>;

  beforeAll(async () => {
    owner = await createOwner('Pub');
    await core.getInfra().db.organization.update({ where: { id: owner.organizationId }, data: { plan: 'AGENCY' } });
    setup = await createClientWithMock(owner.ctx, ['FACEBOOK', 'LINKEDIN', 'INSTAGRAM']);
  });
  afterAll(async () => core.closeInfra());

  const scheduledPost = async (contentId: string) => (await core.getInfra().db.scheduledPost.findMany({ where: { contentId, status: { not: 'CANCELLED' } } }))[0]!;

  it('requires approval before scheduling when the client demands it', async () => {
    const content = await core.createContent(owner.ctx, { clientId: setup.client.id, title: 't', contentType: 'POST', baseContent: 'x', variants: [{ platform: 'FACEBOOK', socialAccountId: setup.accounts.FACEBOOK!.id, caption: 'hello', hashtags: [] }] });
    await expect(core.scheduleContent(owner.ctx, content.id, { scheduledAt: new Date(Date.now() + 60_000) })).rejects.toThrow(/requires approval/);
  });

  it('validates platform capabilities before scheduling (Instagram needs media)', async () => {
    const content = await core.createContent(owner.ctx, { clientId: setup.client.id, title: 't', contentType: 'POST', baseContent: 'x', variants: [{ platform: 'INSTAGRAM', socialAccountId: setup.accounts.INSTAGRAM!.id, caption: 'no media', hashtags: [] }] });
    await core.submitForApproval(owner.ctx, content.id);
    await core.decideApproval(owner.ctx, content.id, { decision: 'APPROVE' });
    await expect(core.publishNow(owner.ctx, content.id)).rejects.toMatchObject({ status: 422, details: { variants: [expect.objectContaining({ platform: 'INSTAGRAM' })] } });
  });

  it('publishes, stores the platform post id and is idempotent', async () => {
    const content = await createApprovedContent(owner.ctx, setup.client.id, [
      { platform: 'FACEBOOK', socialAccountId: setup.accounts.FACEBOOK!.id, caption: 'Fresh bread today' },
      { platform: 'LINKEDIN', socialAccountId: setup.accounts.LINKEDIN!.id, caption: 'Our craft, explained' },
    ]);
    await core.publishNow(owner.ctx, content.id);
    const posts = await core.getInfra().db.scheduledPost.findMany({ where: { contentId: content.id, status: { not: 'CANCELLED' } } });
    const outcomes = await Promise.all(posts.map((p) => core.executePublish(p.id, 1)));
    expect(outcomes.every((o) => o.status === 'published')).toBe(true);
    // Running again (duplicate job delivery) never re-publishes.
    for (const p of posts) expect(await core.executePublish(p.id, 1)).toMatchObject({ status: 'skipped', reason: 'Already published' });
    const after = await core.getContent(owner.ctx, content.id);
    expect(after.status).toBe('PUBLISHED');
    expect(after.scheduledPosts.every((p) => p.publishedPost?.platformPostId.startsWith('mock_'))).toBe(true);
    expect(await core.getInfra().db.publishedPost.count({ where: { scheduledPost: { contentId: content.id } } })).toBe(2);
  });

  it('retries transient failures and fails after max attempts with a notification', async () => {
    const content = await createApprovedContent(owner.ctx, setup.client.id, [{ platform: 'FACEBOOK', socialAccountId: setup.accounts.FACEBOOK!.id, caption: `flaky ${MOCK_FAILURE_MARKERS.transient}` }]);
    await core.publishNow(owner.ctx, content.id);
    const post = await scheduledPost(content.id);
    expect(await core.executePublish(post.id, 1)).toMatchObject({ status: 'retry' });
    expect((await core.getInfra().db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe('QUEUED');
    expect(await core.executePublish(post.id, 2)).toMatchObject({ status: 'retry' });
    expect(await core.executePublish(post.id, 3)).toMatchObject({ status: 'failed' });
    const final = await core.getInfra().db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(final).toMatchObject({ status: 'FAILED', attempts: 3, lastErrorCode: 'SERVER_ERROR' });
    expect((await core.getContent(owner.ctx, content.id)).status).toBe('FAILED');
    expect(await core.getInfra().db.notification.count({ where: { userId: owner.user.id, type: 'POST_FAILED' } })).toBeGreaterThan(0);
  });

  it('does not retry non-retryable errors', async () => {
    const content = await createApprovedContent(owner.ctx, setup.client.id, [{ platform: 'FACEBOOK', socialAccountId: setup.accounts.FACEBOOK!.id, caption: `bad ${MOCK_FAILURE_MARKERS.permanent}` }]);
    await core.publishNow(owner.ctx, content.id);
    const post = await scheduledPost(content.id);
    expect(await core.executePublish(post.id, 1)).toMatchObject({ status: 'failed' });
    expect((await core.getInfra().db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } })).attempts).toBe(1);
    // A stale queue delivery for the failed post must not attempt it again.
    expect(await core.executePublish(post.id, 2)).toMatchObject({ status: 'skipped', reason: 'Already failed' });
    expect((await core.getInfra().db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } })).attempts).toBe(1);
  });

  it('flags the account for re-authentication on expired tokens', async () => {
    const extra = await core.connectMockAccount(owner.ctx, { clientId: setup.client.id, platform: 'FACEBOOK', displayName: 'Second page' });
    const content = await createApprovedContent(owner.ctx, setup.client.id, [{ platform: 'FACEBOOK', socialAccountId: extra.id, caption: `x ${MOCK_FAILURE_MARKERS.auth}` }]);
    await core.publishNow(owner.ctx, content.id);
    expect(await core.executePublish((await scheduledPost(content.id)).id, 1)).toMatchObject({ status: 'failed' });
    expect((await core.getSocialAccount(owner.ctx, extra.id)).status).toBe('REAUTH_REQUIRED');
  });

  it('never re-publishes a post whose previous attempt has an unknown outcome', async () => {
    const content = await createApprovedContent(owner.ctx, setup.client.id, [{ platform: 'FACEBOOK', socialAccountId: setup.accounts.FACEBOOK!.id, caption: 'crash test' }]);
    await core.publishNow(owner.ctx, content.id);
    const post = await scheduledPost(content.id);
    await core.getInfra().db.scheduledPost.update({ where: { id: post.id }, data: { status: 'PUBLISHING', publishingAt: new Date(Date.now() - 60 * 60 * 1000) } });
    expect(await core.executePublish(post.id, 1)).toMatchObject({ status: 'failed' });
    expect((await core.getInfra().db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } })).lastErrorCode).toBe('UNKNOWN_OUTCOME');
  });

  it('editing approved content returns it to draft and cancels the schedule', async () => {
    const content = await createApprovedContent(owner.ctx, setup.client.id, [{ platform: 'FACEBOOK', socialAccountId: setup.accounts.FACEBOOK!.id, caption: 'soon' }]);
    await core.scheduleContent(owner.ctx, content.id, { scheduledAt: new Date(Date.now() + 3600_000) });
    const edited = await core.updateContent(owner.ctx, content.id, { title: 'Changed' });
    expect(edited.status).toBe('DRAFT');
    expect(edited.scheduledPosts.every((p) => p.status === 'CANCELLED')).toBe(true);
  });

  it('records an audit trail for the approval workflow', async () => {
    const content = await createApprovedContent(owner.ctx, setup.client.id, [{ platform: 'FACEBOOK', socialAccountId: setup.accounts.FACEBOOK!.id, caption: 'audited' }]);
    const actions = (await core.getInfra().db.auditLog.findMany({ where: { resourceId: content.id }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(actions).toEqual(['content.created', 'content.submitted_for_approval', 'content.approved']);
  });
});
