import type { SegmentedObject } from '@socialpilot/ai';
import sharp from 'sharp';
import { requirePermission, tenantWhere, type AuthContext } from '../context';
import { AppError, badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { imageProviderFor, segmentationProviderFor } from './ai-settings.service';
import { audit } from './audit.service';
import { getClient, getClientSettings } from './client.service';
import { uploadMedia } from './media.service';
import { assertAiQuota, incrementUsage } from './organization.service';

/**
 * Product photo studio. SAM 3.1 cuts the product out of a client's own photo;
 * the cutout becomes a clean studio shot on the brand colour, and Muse Image
 * places the same product in a new scene. Every result lands in the media library.
 */

/** Photos are scaled down to this before segmenting; plenty for social posts. */
const MAX_SIDE = 1600;
const STUDIO_SIZE = 1080;
const HEX = /^#[0-9a-f]{6}$/i;

async function loadPhoto(ctx: AuthContext, mediaId: string) {
  const { db, storage } = getInfra();
  const media = await db.mediaAsset.findFirst({ where: { id: mediaId, ...tenantWhere(ctx) } });
  if (!media) throw notFound('Photo');
  if (media.kind !== 'IMAGE') throw badRequest('Choose a photo (JPEG, PNG or WebP)');
  return { media, data: await storage.get(media.storageKey) };
}

async function prepareClient(ctx: AuthContext, clientId: string) {
  requirePermission(ctx, 'content:create');
  const client = await getClient(ctx, clientId);
  if (!(await getClientSettings(ctx.organizationId, client.id)).aiEnabled) throw badRequest('AI is disabled for this client');
  await assertAiQuota(ctx.organizationId);
  return client;
}

/**
 * Combines the masks of every match into one full-frame alpha channel. Each mask is
 * smaller than its box, so it's stretched over the box with smoothing for soft edges.
 */
export async function alphaFromObjects(width: number, height: number, objects: SegmentedObject[]): Promise<Buffer> {
  const alpha = Buffer.alloc(width * height);
  for (const o of objects) {
    const left = Math.max(0, Math.floor(o.bounds.left));
    const top = Math.max(0, Math.floor(o.bounds.top));
    const right = Math.min(width, Math.ceil(o.bounds.right));
    const bottom = Math.min(height, Math.ceil(o.bounds.bottom));
    const bw = right - left;
    const bh = bottom - top;
    if (bw <= 0 || bh <= 0 || !o.mask.width || !o.mask.height) continue;
    const raster = Buffer.from(o.mask.data.map((v) => (v ? 255 : 0)));
    const scaled = await sharp(raster, { raw: { width: o.mask.width, height: o.mask.height, channels: 1 } })
      .resize(bw, bh, { fit: 'fill', kernel: 'cubic' })
      .extractChannel(0)
      .raw()
      .toBuffer();
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = (top + y) * width + left + x;
        const v = scaled[y * bw + x]!;
        if (v > alpha[i]!) alpha[i] = v;
      }
    }
  }
  return alpha;
}

/** The cutout centred on a square background with a soft drop shadow. */
export async function studioShot(cutout: Buffer, background: string, size = STUDIO_SIZE): Promise<Buffer> {
  const box = Math.round(size * 0.78);
  const fitted = await sharp(cutout).resize({ width: box, height: box, fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
  const pad = Math.round(size * 0.04);
  // Separate passes: sharp applies operations in its own fixed order within one pipeline.
  const padded = await sharp(fitted.data).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const silhouette = await sharp(padded).ensureAlpha().linear([0, 0, 0, 0.32], [0, 0, 0, 0]).png().toBuffer();
  const shadow = await sharp(silhouette).blur(Math.max(1, size / 60)).png().toBuffer();
  const left = Math.round((size - fitted.info.width) / 2);
  const top = Math.round((size - fitted.info.height) / 2) - Math.round(size * 0.02);
  return sharp({ create: { width: size, height: size, channels: 3, background } })
    .composite([
      { input: shadow, left: left - pad, top: top - pad + Math.round(size * 0.025) },
      { input: fitted.data, left, top },
    ])
    .png()
    .toBuffer();
}

/** Step 1: SAM 3.1 finds the product and cuts it out; also makes a studio shot from it. */
export async function cutOutProduct(ctx: AuthContext, input: { mediaId: string; product: string; background?: string }) {
  const { media, data } = await loadPhoto(ctx, input.mediaId);
  const client = await prepareClient(ctx, media.clientId);
  const product = input.product.trim().slice(0, 80);
  if (!product) throw badRequest('Say what to cut out, like "cake" or "red handbag"');
  const background = input.background && HEX.test(input.background) ? input.background : '#f4f2ee';

  const base = await sharp(data, { failOn: 'none' }).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = base.info;
  const raw = { width, height, channels: 3 as const };
  const jpeg = await sharp(base.data, { raw }).jpeg({ quality: 90 }).toBuffer();

  const segmenter = await segmentationProviderFor(ctx.organizationId);
  let result;
  try {
    result = await segmenter.segment({ image: jpeg, mimeType: 'image/jpeg', prompt: product, width, height });
  } catch (error) {
    throw new AppError('INTEGRATION_ERROR', `Cutout failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  await incrementUsage(ctx.organizationId, 'aiGenerations');
  if (!result.objects.length) throw badRequest(`SAM 3.1 didn't find "${product}" in this photo. Try a simpler name, like "cake" or "bottle".`);

  const alpha = await alphaFromObjects(width, height, result.objects);
  // Crop to the matches with a little room around them.
  const b = result.objects.reduce((acc, o) => ({ left: Math.min(acc.left, o.bounds.left), top: Math.min(acc.top, o.bounds.top), right: Math.max(acc.right, o.bounds.right), bottom: Math.max(acc.bottom, o.bounds.bottom) }), { left: width, top: height, right: 0, bottom: 0 });
  const margin = Math.round(Math.max(width, height) * 0.02);
  const crop = { left: Math.max(0, Math.floor(b.left) - margin), top: Math.max(0, Math.floor(b.top) - margin) };
  const extract = { ...crop, width: Math.min(width, Math.ceil(b.right) + margin) - crop.left, height: Math.min(height, Math.ceil(b.bottom) + margin) - crop.top };
  const rgba = await sharp(base.data, { raw }).joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const cutout = await sharp(rgba).extract(extract).png().toBuffer();
  const studio = await studioShot(cutout, background);

  const stem = media.fileName.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'product';
  const cutoutMedia = await uploadMedia(ctx, { clientId: client.id, fileName: `${stem}-cutout.png`, declaredMime: 'image/png', data: cutout });
  const studioMedia = await uploadMedia(ctx, { clientId: client.id, fileName: `${stem}-studio.png`, declaredMime: 'image/png', data: studio });
  await audit(ctx, { action: 'media.product_cutout', resourceType: 'MediaAsset', resourceId: cutoutMedia.id, clientId: client.id, after: { source: media.id, product, matches: result.objects.length, model: result.model, provider: segmenter.name } });
  return { cutout: cutoutMedia, studio: studioMedia, matches: result.objects.length, model: result.model, provider: segmenter.name };
}

/** Step 2: Muse Image puts the cut-out product in a new scene, keeping the product as it is. */
export async function createProductScene(ctx: AuthContext, input: { cutoutMediaId: string; product: string; scene: string }) {
  const { media, data } = await loadPhoto(ctx, input.cutoutMediaId);
  const client = await prepareClient(ctx, media.clientId);
  const scene = input.scene.trim().slice(0, 500);
  if (!scene) throw badRequest('Describe the scene, like "on a marble kitchen counter in morning light"');
  const product = input.product.trim().slice(0, 80) || 'product';
  const brand = (await getInfra().db.brandProfile.findUnique({ where: { clientId: client.id } }))?.brandName ?? client.name;

  const source = await studioShot(data, '#ffffff', 1024);
  const prompt = [
    `A product photo for ${brand}. Place this exact ${product} ${scene}.`,
    `Keep the ${product} itself unchanged: the same shape, colours, label, text and details.`,
    'Change only the background, surface and lighting so it looks like a real photograph, with natural shadows and reflections.',
    'Do not add text, logos, people or other products.',
  ].join(' ');

  const provider = await imageProviderFor(ctx.organizationId);
  let image;
  try {
    image = await provider.edit({ images: [{ data: source, mimeType: 'image/png' }], prompt, user: ctx.organizationId });
  } catch (error) {
    throw new AppError('INTEGRATION_ERROR', `Scene creation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  await incrementUsage(ctx.organizationId, 'aiGenerations');
  // Muse Image edits come back as WebP; Instagram and others want PNG or JPEG.
  const png = await sharp(image.data).png().toBuffer();
  const stem = media.fileName.replace(/-cutout\.png$|\.[a-z0-9]+$/i, '').slice(0, 60) || 'product';
  const sceneMedia = await uploadMedia(ctx, { clientId: client.id, fileName: `${stem}-scene.png`, declaredMime: 'image/png', data: png });
  await audit(ctx, { action: 'media.product_scene', resourceType: 'MediaAsset', resourceId: sceneMedia.id, clientId: client.id, after: { source: media.id, scene, model: image.model, provider: provider.name } });
  return { media: sceneMedia, model: image.model, provider: provider.name, prompt };
}
