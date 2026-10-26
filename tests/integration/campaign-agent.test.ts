import * as core from '@socialpilot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createClientWithMock, createOwner } from './helpers';

describe('Campaign Agent', () => {
  let owner: Awaited<ReturnType<typeof createOwner>>;
  let setup: Awaited<ReturnType<typeof createClientWithMock>>;
  const { db } = core.getInfra();

  beforeAll(async () => {
    owner = await createOwner('Agent');
    await db.organization.update({ where: { id: owner.organizationId }, data: { plan: 'AGENCY' } });
    setup = await createClientWithMock(owner.ctx, ['INSTAGRAM', 'FACEBOOK', 'WHATSAPP']);
    const src = await core.createKnowledgeSource(owner.ctx, { clientId: setup.client.id, type: 'FAQ', title: 'Classes', content: 'Weekend baking classes run Saturday 10am. They cost 35 pounds per person, 8 places per class.' });
    await core.processKnowledgeSource(src.id);
  });
  afterAll(async () => core.closeInfra());

  it('turns a goal into approved-pending post drafts with images, a sign-up form and a recorded timeline', async () => {
    const run = await core.startCampaignRun(owner.ctx, { clientId: setup.client.id, goal: 'Fill our weekend baking classes for November', startDate: new Date('2026-11-02T00:00:00Z'), days: 7 });
    expect(run.status).toBe('QUEUED');
    const result = await core.executeCampaignRun(run.id);
    expect(result).toMatchObject({ status: 'COMPLETED', posts: 3 });

    const done = await core.getCampaignRun(owner.ctx, run.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.summary).toContain('Prepared 3 posts');
    const tools = (done.steps as { tool: string; ok: boolean }[]).map((s) => s.tool);
    expect(tools).toEqual(['get_business_profile', 'search_knowledge', 'get_recent_posts', 'create_signup_form', 'create_post_draft', 'create_post_draft', 'create_post_draft', 'generate_post_image', 'generate_post_image', 'generate_post_image', 'finish']);
    expect((done.steps as { ok: boolean }[]).every((s) => s.ok)).toBe(true);

    // Posts: in a campaign, planned inside the period, on connected postable platforms only, each with an image, all waiting for approval.
    expect(done.contents).toHaveLength(3);
    for (const c of done.contents as { status: string; scheduledAt: Date; variants: { platform: string; media: unknown[] }[] }[]) {
      expect(c.status).toBe('PENDING_APPROVAL');
      expect(c.scheduledAt.getTime()).toBeGreaterThanOrEqual(new Date('2026-11-02T00:00:00Z').getTime());
      expect(c.scheduledAt.getTime()).toBeLessThan(new Date('2026-11-10T00:00:00Z').getTime());
      expect(c.variants.map((v) => v.platform).sort()).toEqual(['FACEBOOK', 'INSTAGRAM']);
      expect(c.variants.some((v) => v.media.length === 1)).toBe(true);
    }
    expect(await db.campaign.count({ where: { id: done.campaignId!, organizationId: owner.organizationId } })).toBe(1);
    expect(await db.approval.count({ where: { contentId: { in: (done.contents as { id: string }[]).map((c) => c.id) } } })).toBe(3);

    // The sign-up form exists and the posts point to it.
    const form = await db.leadForm.findFirstOrThrow({ where: { clientId: setup.client.id, name: { startsWith: 'Campaign:' } } });
    expect((form.fields as { key: string }[]).map((f) => f.key)).toEqual(['name', 'email', 'phone', 'question_1', 'question_2']);
    expect((done.contents as { variants: { caption: string }[] }[])[0]!.variants[0]!.caption).toContain('link in our bio');
    expect(done.inputTokens).toBeGreaterThanOrEqual(0);
  });

  it('is tenant-isolated, needs permission, can be cancelled, and respects the AI allowance', async () => {
    const run = await core.startCampaignRun(owner.ctx, { clientId: setup.client.id, goal: 'Promote our new sourdough loaf this week', days: 5 });
    const other = await createOwner('AgentOther');
    await expect(core.getCampaignRun(other.ctx, run.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const viewer = await addMember(owner.organizationId, 'VIEWER');
    await expect(core.startCampaignRun(viewer.ctx, { clientId: setup.client.id, goal: 'Promote our new sourdough loaf this week' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await core.cancelCampaignRun(owner.ctx, run.id);
    expect(await core.executeCampaignRun(run.id)).toMatchObject({ skipped: true });
    expect((await core.getCampaignRun(owner.ctx, run.id)).status).toBe('CANCELLED');

    const used = (await core.getUsage(owner.organizationId)).aiGenerations;
    await db.organization.update({ where: { id: owner.organizationId }, data: { limits: { aiGenerations: used } } });
    await expect(core.startCampaignRun(owner.ctx, { clientId: setup.client.id, goal: 'Promote our new sourdough loaf this week' })).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
    await db.organization.update({ where: { id: owner.organizationId }, data: { limits: {} } });
  });
});
