import * as core from '@socialpilot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClientWithMock, createOwner } from './helpers';

describe('AI images and the monthly AI limit', () => {
  let owner: Awaited<ReturnType<typeof createOwner>>;
  let setup: Awaited<ReturnType<typeof createClientWithMock>>;

  beforeAll(async () => {
    owner = await createOwner('Img');
    setup = await createClientWithMock(owner.ctx, ['INSTAGRAM', 'LINKEDIN']);
  });
  afterAll(async () => core.closeInfra());

  const newContent = () =>
    core.createContent(owner.ctx, {
      clientId: setup.client.id, title: 'Autumn menu', contentType: 'POST', baseContent: 'Autumn menu is here',
      variants: [
        { platform: 'INSTAGRAM', socialAccountId: setup.accounts.INSTAGRAM!.id, caption: 'Pumpkin loaf is back', hashtags: [], mediaPrompt: 'A pumpkin loaf on a rustic table' },
        { platform: 'LINKEDIN', socialAccountId: setup.accounts.LINKEDIN!.id, caption: 'Our autumn menu', hashtags: [] },
      ],
    });

  it('creates an image from the brief, stores it as client media, and counts it', async () => {
    const content = await newContent();
    const ig = content.variants.find((v) => v.platform === 'INSTAGRAM')!;
    const before = (await core.getUsage(owner.organizationId)).aiGenerations;
    const result = await core.generateVariantImage(owner.ctx, content.id, ig.id);
    // No Meta key in tests, outside production: the offline placeholder is used.
    expect(result.provider).toBe('mock');
    expect(result.prompt).toContain('A pumpkin loaf on a rustic table');
    expect(result.prompt).toMatch(/No text/);
    expect(result.media).toMatchObject({ clientId: setup.client.id, kind: 'IMAGE', mimeType: 'image/png', width: 432, height: 768 });
    expect((await core.getUsage(owner.organizationId)).aiGenerations).toBe(before + 1);

    // The image can be attached to the version like any upload.
    const saved = await core.upsertVariant(owner.ctx, content.id, { platform: 'INSTAGRAM', socialAccountId: setup.accounts.INSTAGRAM!.id, caption: ig.caption, hashtags: [], mediaIds: [result.media.id] }, ig.id);
    expect(saved.variants.find((v) => v.id === ig.id)!.media.map((m) => m.media.id)).toEqual([result.media.id]);

    const li = content.variants.find((v) => v.platform === 'LINKEDIN')!;
    expect((await core.generateVariantImage(owner.ctx, content.id, li.id, { prompt: 'Team photo outside the bakery' })).media).toMatchObject({ width: 768, height: 432 });
  });

  it('keeps other organizations out', async () => {
    const content = await newContent();
    const other = await createOwner('ImgOther');
    await expect(core.generateVariantImage(other.ctx, content.id, content.variants[0]!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stops AI writing and images once the monthly AI limit is reached', async () => {
    const content = await newContent();
    const { db } = core.getInfra();
    const used = (await core.getUsage(owner.organizationId)).aiGenerations;
    await db.organization.update({ where: { id: owner.organizationId }, data: { limits: { aiGenerations: used } } });
    await expect(core.generateVariantImage(owner.ctx, content.id, content.variants[0]!.id)).rejects.toMatchObject({ code: 'PLAN_LIMIT', message: expect.stringMatching(/AI generations are used up/) });
    await expect(core.generateContent(owner.ctx, { clientId: setup.client.id, topic: 'Winter menu', platforms: ['INSTAGRAM'], contentType: 'POST' } as never)).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
    await db.organization.update({ where: { id: owner.organizationId }, data: { limits: {} } });
  });
});
