import * as core from '@socialpilot/core';
import {
  approvalDecisionSchema,
  contentListQuerySchema,
  createCampaignSchema,
  createContentSchema,
  generateContentSchema,
  scheduleContentSchema,
  updateContentSchema,
  variantInputSchema,
} from '@socialpilot/validation';
import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { z } from 'zod';
import { repoRoot } from '@socialpilot/config';
import { AppError } from '@socialpilot/core';
import { doc, idParam, noContent, parse, requireCtx } from '../http';

const variantParams = z.object({ id: z.string().min(1).max(64), variantId: z.string().min(1).max(64) });

export async function contentRoutes(app: FastifyInstance) {
  app.get('/content', { schema: { tags: ['content'] } }, async (req) => core.listContent(await requireCtx(req), parse(contentListQuerySchema, req.query)));

  app.post('/content', { schema: { tags: ['content'], body: doc(createContentSchema) } }, async (req, reply) =>
    reply.status(201).send(await core.createContent(await requireCtx(req), parse(createContentSchema, req.body))),
  );

  app.post('/content/generate', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags: ['content'], body: doc(generateContentSchema) } }, async (req, reply) =>
    reply.status(201).send(await core.generateContent(await requireCtx(req), parse(generateContentSchema, req.body))),
  );

  app.get('/content/:id', { schema: { tags: ['content'] } }, async (req) => core.getContent(await requireCtx(req), parse(idParam, req.params).id));

  app.patch('/content/:id', { schema: { tags: ['content'], body: doc(updateContentSchema) } }, async (req) =>
    core.updateContent(await requireCtx(req), parse(idParam, req.params).id, parse(updateContentSchema, req.body)),
  );

  app.delete('/content/:id', { schema: { tags: ['content'] } }, async (req, reply) => {
    await core.deleteContent(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });

  app.post('/content/:id/duplicate', { schema: { tags: ['content'] } }, async (req, reply) =>
    reply.status(201).send(await core.duplicateContent(await requireCtx(req), parse(idParam, req.params).id)),
  );

  app.post('/content/:id/variants', { schema: { tags: ['content'], body: doc(variantInputSchema) } }, async (req) =>
    core.upsertVariant(await requireCtx(req), parse(idParam, req.params).id, parse(variantInputSchema, req.body)),
  );

  app.patch('/content/:id/variants/:variantId', { schema: { tags: ['content'] } }, async (req) => {
    const p = parse(variantParams, req.params);
    const ctx = await requireCtx(req);
    const current = await core.getContent(ctx, p.id);
    const variant = current.variants.find((v) => v.id === p.variantId);
    if (!variant) throw new AppError('NOT_FOUND', 'Variant not found');
    const body = parse(variantInputSchema.partial(), req.body);
    return core.upsertVariant(
      ctx,
      p.id,
      parse(variantInputSchema, {
        platform: variant.platform,
        socialAccountId: variant.socialAccountId,
        title: variant.title,
        caption: variant.caption,
        hashtags: variant.hashtags,
        callToAction: variant.callToAction,
        mediaType: variant.mediaType,
        mediaPrompt: variant.mediaPrompt,
        ...body,
      }),
      p.variantId,
    );
  });

  app.delete('/content/:id/variants/:variantId', { schema: { tags: ['content'] } }, async (req) => {
    const p = parse(variantParams, req.params);
    return core.deleteVariant(await requireCtx(req), p.id, p.variantId);
  });

  app.post('/content/:id/variants/:variantId/regenerate', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags: ['content'] } }, async (req) => {
    const p = parse(variantParams, req.params);
    const body = parse(z.object({ instructions: z.string().max(1000).optional() }), req.body);
    return core.regenerateVariant(await requireCtx(req), p.id, p.variantId, body.instructions);
  });

  /** Muse Image: an image for this version from its creative brief (or a custom description). */
  app.post('/content/:id/variants/:variantId/image', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['content'] } }, async (req) => {
    const p = parse(variantParams, req.params);
    const body = parse(z.object({ prompt: z.string().trim().max(1000).optional() }), req.body);
    return core.generateVariantImage(await requireCtx(req), p.id, p.variantId, body);
  });

  app.post('/content/:id/submit', { schema: { tags: ['approvals'] } }, async (req) => core.submitForApproval(await requireCtx(req), parse(idParam, req.params).id));

  app.post('/content/:id/approve', { schema: { tags: ['approvals'], body: doc(approvalDecisionSchema) } }, async (req) =>
    core.decideApproval(await requireCtx(req), parse(idParam, req.params).id, parse(approvalDecisionSchema, req.body)),
  );

  app.post('/content/:id/schedule', { schema: { tags: ['publishing'], body: doc(scheduleContentSchema) } }, async (req) =>
    core.scheduleContent(await requireCtx(req), parse(idParam, req.params).id, parse(scheduleContentSchema, req.body)),
  );

  app.post('/content/:id/publish', { schema: { tags: ['publishing'] } }, async (req) => core.publishNow(await requireCtx(req), parse(idParam, req.params).id));

  app.post('/content/:id/reschedule', { schema: { tags: ['publishing'] } }, async (req) => {
    const body = parse(z.object({ scheduledAt: z.coerce.date() }), req.body);
    return core.rescheduleContent(await requireCtx(req), parse(idParam, req.params).id, body.scheduledAt);
  });

  app.post('/content/:id/cancel-schedule', { schema: { tags: ['publishing'] } }, async (req) => core.cancelSchedule(await requireCtx(req), parse(idParam, req.params).id));

  app.get('/approvals', { schema: { tags: ['approvals'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional(), status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED']).optional() }), req.query);
    return core.listApprovals(await requireCtx(req), q);
  });

  app.get('/calendar', { schema: { tags: ['content'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional(), from: z.coerce.date(), to: z.coerce.date() }).refine((v) => v.to.getTime() - v.from.getTime() <= 100 * 86_400_000, 'Range too large (max 100 days)'), req.query);
    return core.getCalendar(await requireCtx(req), q);
  });

  app.get('/campaigns', { schema: { tags: ['content'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional() }), req.query);
    return core.listCampaigns(await requireCtx(req), q.clientId);
  });

  app.post('/campaigns', { schema: { tags: ['content'], body: doc(createCampaignSchema) } }, async (req, reply) =>
    reply.status(201).send(await core.createCampaign(await requireCtx(req), parse(createCampaignSchema, req.body))),
  );

  // ── Media ──
  app.post('/media', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags: ['media'], consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const ctx = await requireCtx(req);
    const file = await req.file();
    if (!file) throw new AppError('BAD_REQUEST', 'Attach a file in the "file" field');
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const clientId = parse(z.string().min(1).max(64), fields.clientId?.value);
    const purpose = fields.purpose?.value === 'knowledge' ? 'knowledge' : 'content';
    const data = await file.toBuffer();
    if (file.file.truncated) throw new AppError('BAD_REQUEST', 'The file exceeds the upload limit');
    return reply.status(201).send(await core.uploadMedia(ctx, { clientId, fileName: file.filename, declaredMime: file.mimetype, data, purpose }));
  });

  app.get('/media', { schema: { tags: ['media'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().min(1), kind: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']).optional() }), req.query);
    return core.listMedia(await requireCtx(req), q.clientId, q.kind);
  });

  app.delete('/media/:id', { schema: { tags: ['media'] } }, async (req, reply) => {
    await core.deleteMedia(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });
}

/** Serves files for the development-only local storage driver. */
export async function localMediaRoutes(app: FastifyInstance) {
  const root = resolve(join(repoRoot(), '.data', 'storage'));
  const TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv' };
  app.get('/media/local/*', { schema: { hide: true } }, async (req, reply) => {
    if (core.getInfra().env.STORAGE_DRIVER !== 'local') return reply.status(404).send();
    const key = decodeURIComponent((req.params as { '*': string })['*']);
    const full = normalize(join(root, key));
    if (!full.startsWith(root + sep) || !existsSync(full)) return reply.status(404).send();
    const ext = full.split('.').pop() ?? '';
    reply.header('x-content-type-options', 'nosniff').header('content-disposition', 'inline');
    return reply.type(TYPES[ext] ?? 'application/octet-stream').send(createReadStream(full));
  });
}
