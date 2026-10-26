import { randomUUID } from 'node:crypto';
import { requirePermission, tenantWhere, type AuthContext, type ServiceContext } from '../context';
import { badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { inspectMedia } from '../lib/media-inspect';
import { audit } from './audit.service';
import { getClient } from './client.service';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/webm': 'weba',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
};

export async function uploadMedia(ctx: AuthContext, input: { clientId: string; fileName: string; declaredMime: string; data: Buffer; purpose?: 'content' | 'knowledge' }) {
  requirePermission(ctx, input.purpose === 'knowledge' ? 'knowledge:manage' : 'content:create');
  await getClient(ctx, input.clientId);
  if (input.data.length === 0) throw badRequest('The file is empty');
  if (input.data.length > MAX_UPLOAD_BYTES) throw badRequest('The file exceeds the 200 MB upload limit');
  const info = inspectMedia(input.data, input.declaredMime, input.fileName);
  if (!info) throw badRequest('Unsupported file type. Upload JPEG, PNG, GIF, WebP, MP4, MOV, WebM, WAV, OGG, MP3, M4A, PDF or plain text.');

  const { db, storage } = getInfra();
  const key = `org/${ctx.organizationId}/client/${input.clientId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${EXT[info.mimeType] ?? 'bin'}`;
  const stored = await storage.put(key, input.data, info.mimeType);
  const safeName = input.fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'file';
  const media = await db.mediaAsset.create({
    data: {
      organizationId: ctx.organizationId,
      clientId: input.clientId,
      kind: info.kind,
      storageKey: key,
      url: stored.url,
      fileName: safeName,
      mimeType: info.mimeType,
      size: stored.size,
      width: info.width,
      height: info.height,
      uploadedById: ctx.userId,
    },
  });
  await audit(ctx, { action: 'media.uploaded', resourceType: 'MediaAsset', resourceId: media.id, clientId: input.clientId, after: { fileName: safeName, mimeType: info.mimeType, size: stored.size } });
  return media;
}

export async function listMedia(ctx: ServiceContext, clientId: string, kind?: 'IMAGE' | 'VIDEO' | 'DOCUMENT') {
  requirePermission(ctx, 'content:view');
  return getInfra().db.mediaAsset.findMany({ where: { ...tenantWhere(ctx, clientId), ...(kind ? { kind } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
}

export async function deleteMedia(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'content:delete');
  const { db, storage } = getInfra();
  const media = await db.mediaAsset.findFirst({ where: { id, ...tenantWhere(ctx) } });
  if (!media) throw notFound('Media');
  await db.mediaAsset.delete({ where: { id } });
  await storage.delete(media.storageKey).catch(() => undefined);
  await audit(ctx, { action: 'media.deleted', resourceType: 'MediaAsset', resourceId: id, clientId: media.clientId, before: { fileName: media.fileName } });
}
