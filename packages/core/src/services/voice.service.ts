import { randomUUID } from 'node:crypto';
import type { Prisma } from '@socialpilot/database';
import type { MessageAttachment } from '@socialpilot/social';
import { getInfra } from '../infra';
import { MAX_VOICE_NOTE_BYTES, toTranscribableWav } from '../lib/audio';
import { truncate } from '../lib/util';
import { transcriptionProviderFor } from './ai-settings.service';
import { incrementUsage } from './organization.service';
import { loadAdapterAccount } from './social.service';

/** The first voice note on a message that hasn't been transcribed or failed yet. */
export function pendingVoiceNote(attachments: unknown): number {
  if (!Array.isArray(attachments)) return -1;
  return (attachments as MessageAttachment[]).findIndex((a) => a?.type === 'audio' && !a.transcript && !a.transcriptError && Boolean(a.mediaAssetId || a.mediaId));
}

/** Words to bias recognition toward: the business, product and service names customers mention. */
function voiceKeywords(brand: { brandName: string; products: string[]; services: string[] } | null, fallbackName: string): string[] {
  const words = [brand?.brandName ?? fallbackName, ...(brand?.products ?? []), ...(brand?.services ?? [])];
  return [...new Set(words.map((w) => w.trim()).filter((w) => w && w.length <= 40))].slice(0, 50);
}

/**
 * Turns a customer's voice note into text with Muse Voice Transcribe (Gemini as the backup),
 * so the rest of the reply pipeline works on it like a typed message. The transcript becomes
 * the message text; the attachment keeps which model produced it. WhatsApp audio is copied
 * into our storage so the team can play it back. Returns null when it couldn't be transcribed.
 */
export async function transcribeVoiceNote(messageId: string): Promise<{ text: string; provider: string; model: string } | null> {
  const { db, storage, logger } = getInfra();
  const message = await db.message.findUnique({ where: { id: messageId }, include: { conversation: { include: { client: { include: { brandProfile: true } } } } } });
  if (!message) return null;
  const attachments = [...((message.attachments ?? []) as unknown as MessageAttachment[])];
  const index = pendingVoiceNote(attachments);
  if (index < 0) return null;
  const note = { ...attachments[index]! };
  const { organizationId, clientId } = message;
  const save = async (data: Partial<{ content: string }> = {}) => {
    attachments[index] = note;
    await db.message.update({ where: { id: messageId }, data: { ...data, attachments: attachments as unknown as Prisma.InputJsonValue } });
  };

  try {
    let audio: Buffer;
    if (note.mediaAssetId) {
      const media = await db.mediaAsset.findFirst({ where: { id: note.mediaAssetId, organizationId, clientId } });
      if (!media) throw new Error('The voice note file no longer exists');
      audio = await storage.get(media.storageKey);
    } else {
      const { adapter, account } = await loadAdapterAccount(organizationId, message.conversation.socialAccountId);
      if (!adapter.downloadMedia) throw new Error(`${account.platform} voice notes can't be downloaded`);
      const file = await adapter.downloadMedia(account, note.mediaId!);
      audio = file.data;
      const mimeType = file.mimeType.split(';')[0]!.trim() || 'audio/ogg';
      const key = `org/${organizationId}/client/${clientId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${mimeType === 'audio/mpeg' ? 'mp3' : mimeType === 'audio/mp4' ? 'm4a' : 'ogg'}`;
      const stored = await storage.put(key, audio, mimeType);
      const asset = await db.mediaAsset.create({ data: { organizationId, clientId, kind: 'AUDIO', storageKey: key, url: stored.url, fileName: 'voice-note', mimeType, size: stored.size } });
      note.mediaAssetId = asset.id;
      note.mimeType = mimeType;
    }
    if (audio.length > MAX_VOICE_NOTE_BYTES) throw new Error('The voice note is larger than 32 MB');

    const wav = await toTranscribableWav(audio);
    const client = message.conversation.client;
    const transcriber = await transcriptionProviderFor(organizationId);
    const result = await transcriber.transcribe({ wav, keywords: voiceKeywords(client.brandProfile, client.name) });
    if (!result.text) throw new Error('No speech was recognized in the voice note');

    note.transcript = result.text;
    note.transcriptProvider = result.provider;
    note.transcriptModel = result.model;
    await save({ content: result.text });
    await db.conversation.updateMany({
      where: { id: message.conversationId, lastMessageAt: { lte: message.createdAt } },
      data: { lastMessagePreview: truncate(`Voice note: ${result.text}`, 160) },
    });
    if (result.provider !== 'mock') await incrementUsage(organizationId, 'aiGenerations');
    return { text: result.text, provider: result.provider, model: result.model };
  } catch (error) {
    note.transcriptError = truncate(error instanceof Error ? error.message : String(error), 300);
    await save();
    logger.warn({ organizationId, messageId, err: note.transcriptError }, 'Voice note transcription failed');
    return null;
  }
}
