import * as core from '@socialpilot/core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClientWithMock, createOwner } from './helpers';

describe('product photo studio', () => {
  let owner: Awaited<ReturnType<typeof createOwner>>;
  let setup: Awaited<ReturnType<typeof createClientWithMock>>;
  const { storage } = core.getInfra();

  beforeAll(async () => {
    owner = await createOwner('Studio');
    setup = await createClientWithMock(owner.ctx, ['INSTAGRAM']);
  });
  afterAll(async () => core.closeInfra());

  // A 400×300 photo: a red "product" in the middle of a grey background.
  const photo = () =>
    sharp({ create: { width: 400, height: 300, channels: 3, background: '#9a9a9a' } })
      .composite([{ input: { create: { width: 200, height: 180, channels: 3, background: '#d02020' } }, left: 100, top: 60 }])
      .jpeg()
      .toBuffer();

  it('cuts the product out with transparency and makes a square studio shot', async () => {
    const upload = await core.uploadMedia(owner.ctx, { clientId: setup.client.id, fileName: 'cake.jpg', declaredMime: 'image/jpeg', data: await photo() });
    const before = (await core.getUsage(owner.organizationId)).aiGenerations;
    const result = await core.cutOutProduct(owner.ctx, { mediaId: upload.id, product: 'cake', background: '#fde8d0' });
    expect(result).toMatchObject({ provider: 'mock', matches: 1 });
    expect(result.cutout).toMatchObject({ kind: 'IMAGE', mimeType: 'image/png', fileName: 'cake-cutout.png' });
    expect((await core.getUsage(owner.organizationId)).aiGenerations).toBe(before + 1);

    const cutout = sharp(await storage.get(result.cutout.storageKey));
    const meta = await cutout.metadata();
    expect(meta.hasAlpha).toBe(true);
    // Cropped to the match (the mock covers the middle 60% × 70%) plus a small margin.
    expect(meta.width).toBeLessThan(400);
    const { data, info } = await cutout.raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!;
    expect(alphaAt(0, 0)).toBe(0); // corner: background removed
    expect(alphaAt(Math.floor(info.width / 2), Math.floor(info.height / 2))).toBe(255); // centre: product kept

    const studio = await sharp(await storage.get(result.studio.storageKey)).metadata();
    expect([studio.width, studio.height]).toEqual([1080, 1080]);
    const corner = await sharp(await storage.get(result.studio.storageKey)).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect([...corner.subarray(0, 3)]).toEqual([0xfd, 0xe8, 0xd0]);
  });

  it('puts the cutout in a new scene and saves it as PNG', async () => {
    const upload = await core.uploadMedia(owner.ctx, { clientId: setup.client.id, fileName: 'bag.jpg', declaredMime: 'image/jpeg', data: await photo() });
    const { cutout } = await core.cutOutProduct(owner.ctx, { mediaId: upload.id, product: 'handbag' });
    const scene = await core.createProductScene(owner.ctx, { cutoutMediaId: cutout.id, product: 'handbag', scene: 'on a marble counter in morning light' });
    expect(scene.prompt).toContain('Place this exact handbag on a marble counter in morning light');
    expect(scene.prompt).toMatch(/unchanged/);
    expect(scene.media).toMatchObject({ kind: 'IMAGE', mimeType: 'image/png', fileName: 'bag-scene.png' });
  });

  it('refuses non-photos and other tenants’ media', async () => {
    const doc = await core.uploadMedia(owner.ctx, { clientId: setup.client.id, fileName: 'notes.txt', declaredMime: 'text/plain', data: Buffer.from('hello') });
    await expect(core.cutOutProduct(owner.ctx, { mediaId: doc.id, product: 'cake' })).rejects.toMatchObject({ status: 400 });
    const other = await createOwner('StudioOther');
    const upload = await core.uploadMedia(owner.ctx, { clientId: setup.client.id, fileName: 'x.jpg', declaredMime: 'image/jpeg', data: await photo() });
    await expect(core.cutOutProduct(other.ctx, { mediaId: upload.id, product: 'cake' })).rejects.toMatchObject({ status: 404 });
  });
});
