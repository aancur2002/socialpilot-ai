import { randomUUID } from 'node:crypto';
import { isUniqueViolation, type Platform, type Prisma } from '@socialpilot/database';
import { signMockWebhook, type MockWebhookPayload, type NormalizedWebhookEvent, type PlatformKey, type WebhookRequest } from '@socialpilot/social';
import { requirePermission, tenantWhere, type AuthContext } from '../context';
import { AppError, badRequest, notFound } from '../errors';
import { getInfra, mockWebhookSecret } from '../infra';
import { ingestNormalizedEvent } from './inbox.service';
import { getSocial } from './platform-credentials.service';

export interface WebhookReceipt {
  received: number;
  duplicates: number;
  ignored: number;
}

/** GET handshake used by Meta platforms (and the mock provider). */
export async function answerWebhookChallenge(platform: PlatformKey, query: Record<string, string | undefined>, mock = false): Promise<string | null> {
  const social = await getSocial();
  const adapter = mock ? social.mock(platform) : social.realAdapter(platform);
  return adapter.handleWebhookChallenge?.(query) ?? null;
}

/**
 * Webhook intake: verify signature → normalize → persist idempotently → queue.
 * Heavy work happens in the worker so the platform gets a fast 200.
 */
export async function receiveWebhook(platform: PlatformKey, req: WebhookRequest, mock = false): Promise<WebhookReceipt> {
  const { db, queues, logger } = getInfra();
  const social = await getSocial();
  const adapter = mock ? social.mock(platform) : social.realAdapter(platform);
  if (!adapter.verifyWebhookSignature || !adapter.parseWebhook) throw new AppError('NOT_FOUND', `${platform} does not deliver webhooks`);
  if (!adapter.verifyWebhookSignature(req)) throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature');

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    throw badRequest('Webhook body is not valid JSON');
  }
  const events = adapter.parseWebhook(payload);
  const receipt: WebhookReceipt = { received: 0, duplicates: 0, ignored: 0 };

  for (const event of events) {
    const accounts = await db.socialAccount.findMany({
      where: { platform: platform as Platform, platformAccountId: event.platformAccountId, isMock: mock, status: { not: 'DISCONNECTED' } },
      select: { id: true, organizationId: true, clientId: true },
    });
    if (!accounts.length) {
      receipt.ignored++;
      logger.info({ platform, eventKind: event.kind }, 'webhook for unknown account ignored');
      continue;
    }
    for (const account of accounts) {
      try {
        const row = await db.webhookEvent.create({
          data: {
            platform: platform as Platform,
            eventKey: `${event.eventKey}:${account.id}`,
            eventType: event.kind,
            socialAccountId: account.id,
            organizationId: account.organizationId,
            clientId: account.clientId,
            payload: event as unknown as Prisma.InputJsonValue,
          },
        });
        await queues.add('webhook', { webhookEventId: row.id }, { jobId: row.id, attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
        receipt.received++;
      } catch (error) {
        if (isUniqueViolation(error)) receipt.duplicates++;
        else throw error;
      }
    }
  }
  return receipt;
}

/** Worker: turns a stored webhook event into contacts/conversations/messages. Idempotent. */
export async function processWebhookEvent(webhookEventId: string): Promise<void> {
  const { db } = getInfra();
  const claimed = await db.webhookEvent.updateMany({ where: { id: webhookEventId, status: { in: ['RECEIVED', 'FAILED'] } }, data: { status: 'PROCESSING', attempts: { increment: 1 } } });
  if (!claimed.count) return;
  const row = await db.webhookEvent.findUniqueOrThrow({ where: { id: webhookEventId } });
  try {
    if (!row.socialAccountId) throw new Error('Webhook event has no social account');
    const event = reviveDates(row.payload as unknown as NormalizedWebhookEvent);
    const outcome = await ingestNormalizedEvent(row.socialAccountId, event);
    await db.webhookEvent.update({ where: { id: webhookEventId }, data: { status: outcome === 'ignored' ? 'IGNORED' : 'PROCESSED', processedAt: new Date(), error: null } });
  } catch (error) {
    await db.webhookEvent.update({ where: { id: webhookEventId }, data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 1000) : String(error) } });
    throw error;
  }
}

function reviveDates(event: NormalizedWebhookEvent): NormalizedWebhookEvent {
  if (event.kind === 'message') event.message.createdAt = new Date(event.message.createdAt);
  if (event.kind === 'comment') event.comment.createdAt = new Date(event.comment.createdAt);
  return event;
}

/**
 * Development helper: simulates an inbound DM or comment on a Mock* account by
 * sending a signed webhook through the real intake path.
 */
export async function simulateInbound(
  ctx: AuthContext,
  input: { socialAccountId: string; type: 'message' | 'comment'; text: string; fromName?: string; fromId?: string; postId?: string },
) {
  requirePermission(ctx, 'messages:view');
  const { db, env, social } = getInfra();
  if (!social.mockEnabled) throw badRequest('Mock mode is disabled');
  const account = await db.socialAccount.findFirst({ where: { id: input.socialAccountId, ...tenantWhere(ctx) } });
  if (!account) throw notFound('Social account');
  if (!account.isMock) throw badRequest('Inbound simulation is only available for mock accounts');
  const fromId = input.fromId ?? `mock_customer_${randomUUID().slice(0, 8)}`;
  const from = { id: fromId, name: input.fromName ?? 'Test Customer', username: input.fromName?.toLowerCase().replace(/\W+/g, '_') };
  const id = `sim_${randomUUID()}`;
  const payload: MockWebhookPayload = {
    events: [
      input.type === 'comment'
        ? { type: 'comment', id, accountId: account.platformAccountId, postId: input.postId ?? `mock_post_${account.id.slice(-6)}`, from, text: input.text }
        : { type: 'message', id, accountId: account.platformAccountId, from, text: input.text },
    ],
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const receipt = await receiveWebhook(account.platform, { rawBody, headers: { 'x-mock-signature': signMockWebhook(mockWebhookSecret(env), rawBody) }, query: {} }, true);
  return { ...receipt, simulatedEventId: id, fromId };
}
