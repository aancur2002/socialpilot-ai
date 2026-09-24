import { chunkText, htmlToText } from '@socialpilot/ai';
import { Prisma, toVectorLiteral, type KnowledgeSourceType } from '@socialpilot/database';
import { PDFParse } from 'pdf-parse';
import { requirePermission, tenantWhere, type AuthContext, type ServiceContext } from '../context';
import { badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { safeFetchText } from '../lib/safe-fetch';
import { audit } from './audit.service';
import { getClient } from './client.service';

export async function listKnowledgeSources(ctx: ServiceContext, clientId: string) {
  requirePermission(ctx, 'knowledge:view');
  return getInfra().db.knowledgeSource.findMany({
    where: tenantWhere(ctx, clientId),
    select: { id: true, clientId: true, type: true, title: true, url: true, mediaId: true, status: true, error: true, chunkCount: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getKnowledgeSource(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'knowledge:view');
  const source = await getInfra().db.knowledgeSource.findFirst({
    where: { id, ...tenantWhere(ctx) },
    include: { chunks: { select: { id: true, index: true, content: true, tokenCount: true }, orderBy: { index: 'asc' }, take: 200 } },
  });
  if (!source) throw notFound('Knowledge source');
  return source;
}

export async function createKnowledgeSource(ctx: AuthContext, input: { clientId: string; type: KnowledgeSourceType; title: string; content?: string; url?: string; mediaId?: string }) {
  requirePermission(ctx, 'knowledge:manage');
  await getClient(ctx, input.clientId);
  const { db, queues } = getInfra();
  if (input.mediaId) {
    const media = await db.mediaAsset.findFirst({ where: { id: input.mediaId, organizationId: ctx.organizationId, clientId: input.clientId } });
    if (!media) throw notFound('Uploaded document');
    if (media.kind !== 'DOCUMENT') throw badRequest('Knowledge documents must be PDF or plain text');
  }
  if (input.type === 'WEBSITE' && !input.url) throw badRequest('A website source needs a URL');
  const source = await db.knowledgeSource.create({
    data: {
      organizationId: ctx.organizationId,
      clientId: input.clientId,
      type: input.type,
      title: input.title,
      content: input.content ?? null,
      url: input.url ?? null,
      mediaId: input.mediaId ?? null,
      createdById: ctx.userId,
    },
  });
  await audit(ctx, { action: 'knowledge.source_added', resourceType: 'KnowledgeSource', resourceId: source.id, clientId: input.clientId, after: { type: input.type, title: input.title } });
  await queues.add('knowledge', { sourceId: source.id }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
  return source;
}

export async function deleteKnowledgeSource(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'knowledge:manage');
  const { db } = getInfra();
  const source = await db.knowledgeSource.findFirst({ where: { id, ...tenantWhere(ctx) } });
  if (!source) throw notFound('Knowledge source');
  await db.knowledgeSource.delete({ where: { id } });
  await audit(ctx, { action: 'knowledge.source_deleted', resourceType: 'KnowledgeSource', resourceId: id, clientId: source.clientId, before: { title: source.title } });
}

async function extractText(source: { type: KnowledgeSourceType; content: string | null; url: string | null; mediaId: string | null; organizationId: string; clientId: string }): Promise<string> {
  const { db, storage } = getInfra();
  if (source.mediaId) {
    const media = await db.mediaAsset.findFirst({ where: { id: source.mediaId, organizationId: source.organizationId, clientId: source.clientId } });
    if (!media) throw new Error('Uploaded document no longer exists');
    const data = await storage.get(media.storageKey);
    if (media.mimeType === 'application/pdf') {
      const parser = new PDFParse({ data });
      try {
        return (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    }
    return data.toString('utf8');
  }
  if (source.type === 'WEBSITE' && source.url) {
    const page = await safeFetchText(source.url);
    return page.contentType.includes('html') ? htmlToText(page.text) : page.text;
  }
  return source.content ?? '';
}

/** Worker: extract → chunk → embed → store vectors. Replaces previous chunks atomically. */
export async function processKnowledgeSource(sourceId: string): Promise<void> {
  const { db, embeddings, logger } = getInfra();
  const source = await db.knowledgeSource.findUnique({ where: { id: sourceId } });
  if (!source) return;
  await db.knowledgeSource.update({ where: { id: sourceId }, data: { status: 'PROCESSING', error: null } });
  try {
    const text = (await extractText(source)).trim();
    if (!text) throw new Error('No text could be extracted from this source');
    const chunks = chunkText(text);
    const vectors = await embeddings.generateEmbeddings(chunks.map((c) => `${source.title}\n${c.content}`));
    await db.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { sourceId } });
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const created = await tx.knowledgeChunk.create({
          data: { organizationId: source.organizationId, clientId: source.clientId, sourceId, index: c.index, content: c.content, tokenCount: c.tokenCount, embeddingModel: embeddings.model },
        });
        await tx.$executeRaw`UPDATE "KnowledgeChunk" SET embedding = ${toVectorLiteral(vectors[i]!)}::vector WHERE id = ${created.id}`;
      }
      await tx.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: 'READY', chunkCount: chunks.length, ...(source.mediaId || source.type === 'WEBSITE' ? { content: text.slice(0, 500_000) } : {}) },
      });
    }, { timeout: 60_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ sourceId, clientId: source.clientId, error: message }, 'knowledge processing failed');
    await db.knowledgeSource.update({ where: { id: sourceId }, data: { status: 'FAILED', error: message.slice(0, 500) } });
    throw error;
  }
}

export interface KnowledgeHit {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  score: number;
}

/**
 * Semantic search restricted to ONE client. The client filter is part of the SQL,
 * so knowledge can never be retrieved across tenants.
 */
export async function searchKnowledgeInternal(organizationId: string, clientId: string, query: string, limit = 5, minScore = 0.1): Promise<KnowledgeHit[]> {
  const { db, embeddings } = getInfra();
  const [vector] = await embeddings.generateEmbeddings([query]);
  if (!vector) return [];
  const rows = await db.$queryRaw<{ id: string; sourceId: string; title: string; content: string; score: number }[]>(Prisma.sql`
    SELECT c.id, c."sourceId", s.title, c.content, 1 - (c.embedding <=> ${toVectorLiteral(vector)}::vector) AS score
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeSource" s ON s.id = c."sourceId"
    WHERE c."organizationId" = ${organizationId}
      AND c."clientId" = ${clientId}
      AND s."clientId" = ${clientId}
      AND s.status = 'READY'
      AND c.embedding IS NOT NULL
      AND c."embeddingModel" = ${embeddings.model}
    ORDER BY c.embedding <=> ${toVectorLiteral(vector)}::vector
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ ...r, score: Number(r.score) })).filter((r) => r.score >= minScore);
}

export async function searchKnowledge(ctx: ServiceContext, input: { clientId: string; query: string; limit: number }) {
  requirePermission(ctx, 'knowledge:view');
  await getClient(ctx, input.clientId);
  return searchKnowledgeInternal(ctx.organizationId, input.clientId, input.query, input.limit, 0);
}
