import { describe, expect, it } from 'vitest';
import { buildAuthContext, canAccessClient, requirePermission, systemContext, tenantWhere } from './context';
import { AppError } from './errors';
import { inspectMedia, sniffMime } from './lib/media-inspect';
import { assertPublicUrl } from './lib/safe-fetch';
import { redactSecrets, slugify } from './lib/util';
import { evaluateCondition, evaluateRules } from './services/automation.service';
import { nextBusinessOpening } from './services/reply.service';

const ctxFor = (role: Parameters<typeof buildAuthContext>[0]['role'], clientAccess: 'ALL' | 'ASSIGNED' = 'ALL', assigned: string[] = []) =>
  buildAuthContext({ userId: 'u1', isSuperAdmin: false, organizationId: 'org1', role, clientAccess, assignedClientIds: assigned });

describe('tenant isolation helpers', () => {
  it('always scopes to the organization', () => {
    expect(tenantWhere(ctxFor('ORG_ADMIN'))).toEqual({ organizationId: 'org1' });
  });

  it('restricts assigned members to their clients', () => {
    const ctx = ctxFor('CLIENT', 'ASSIGNED', ['c1']);
    expect(tenantWhere(ctx)).toEqual({ organizationId: 'org1', clientId: { in: ['c1'] } });
    expect(canAccessClient(ctx, 'c1')).toBe(true);
    expect(canAccessClient(ctx, 'c2')).toBe(false);
  });

  it('returns NOT_FOUND (not FORBIDDEN) for a client outside scope', () => {
    const ctx = ctxFor('VIEWER', 'ASSIGNED', ['c1']);
    try {
      tenantWhere(ctx, 'c2');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(404);
    }
  });

  it('owners and admins see every client even if marked ASSIGNED', () => {
    expect(ctxFor('ORG_OWNER', 'ASSIGNED').clientIds).toBeNull();
  });

  it('enforces permissions', () => {
    expect(() => requirePermission(ctxFor('VIEWER'), 'content:create')).toThrow(/content:create/);
    expect(() => requirePermission(ctxFor('CONTENT_MANAGER'), 'content:create')).not.toThrow();
    expect(() => requirePermission(systemContext('org1'), 'users:manage')).not.toThrow();
  });
});

describe('automation rules engine', () => {
  const facts = { intent: 'GENERAL_QUESTION', confidence: 0.93, platform: 'INSTAGRAM', isSpam: false, text: 'Do you deliver?' };

  it('evaluates each operator', () => {
    expect(evaluateCondition({ field: 'intent', op: 'eq', value: 'GENERAL_QUESTION' }, facts)).toBe(true);
    expect(evaluateCondition({ field: 'intent', op: 'in', value: ['PRICE', 'HOURS'] }, facts)).toBe(false);
    expect(evaluateCondition({ field: 'confidence', op: 'gte', value: 0.9 }, facts)).toBe(true);
    expect(evaluateCondition({ field: 'confidence', op: 'lt', value: 0.9 }, facts)).toBe(false);
    expect(evaluateCondition({ field: 'text', op: 'contains', value: 'DELIVER' }, facts)).toBe(true);
    expect(evaluateCondition({ field: 'isSpam', op: 'eq', value: false }, facts)).toBe(true);
  });

  it('runs the spec example: Instagram general question with confidence ≥ 0.90 → generate + auto-send', () => {
    const { actions } = evaluateRules(
      [{ id: 'r1', priority: 10, platforms: ['INSTAGRAM'], conditions: [{ field: 'intent', op: 'eq', value: 'GENERAL_QUESTION' }, { field: 'confidence', op: 'gte', value: 0.9 }], actions: [{ type: 'generate_reply' }, { type: 'auto_send' }], stopProcessing: false }],
      facts,
    );
    expect(actions.map((a) => a.type)).toEqual(['generate_reply', 'auto_send']);
  });

  it('filters by platform, honours priority and stopProcessing, and ignores invalid rules', () => {
    const rules = [
      { id: 'late', priority: 50, platforms: [], conditions: [], actions: [{ type: 'notify' }], stopProcessing: false },
      { id: 'first', priority: 1, platforms: [], conditions: [{ field: 'intent', op: 'eq', value: 'GENERAL_QUESTION' }], actions: [{ type: 'set_priority', priority: 'HIGH' }], stopProcessing: true },
      { id: 'fb', priority: 0, platforms: ['FACEBOOK'], conditions: [], actions: [{ type: 'escalate' }], stopProcessing: false },
      { id: 'broken', priority: 0, platforms: [], conditions: [{ field: 'nope', op: 'eq', value: 1 }], actions: [{ type: 'escalate' }], stopProcessing: false },
    ];
    const { actions, evaluations } = evaluateRules(rules, facts);
    expect(actions).toEqual([{ type: 'set_priority', priority: 'HIGH' }]);
    expect(evaluations.map((e) => e.ruleId)).toEqual(['first']);
  });
});

describe('media inspection', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000002000000010008060000', 'hex');
  it('sniffs by magic bytes, not the declared type', () => {
    expect(sniffMime(png)).toBe('image/png');
    expect(inspectMedia(png, 'video/mp4', 'x.mp4')).toMatchObject({ mimeType: 'image/png', kind: 'IMAGE', width: 512, height: 256 });
  });
  it('accepts UTF-8 text documents and rejects unknown binaries', () => {
    expect(inspectMedia(Buffer.from('Hello FAQ'), 'text/plain', 'faq.txt')).toMatchObject({ kind: 'DOCUMENT' });
    expect(inspectMedia(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'application/x-msdownload', 'evil.exe')).toBeNull();
  });
});

describe('SSRF protection', () => {
  it.each(['http://127.0.0.1/', 'http://10.0.0.5/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'ftp://example.com/', 'http://example.com:8080/', 'http://user:pass@example.com/'])('rejects %s', async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow();
  });
});

describe('utilities', () => {
  it('redacts secret-looking keys recursively', () => {
    expect(redactSecrets({ name: 'x', accessToken: 'abc', nested: { clientSecret: 's', ok: 1 } })).toEqual({ name: 'x', accessToken: '[REDACTED]', nested: { clientSecret: '[REDACTED]', ok: 1 } });
  });
  it('slugifies safely', () => {
    expect(slugify("Bella's Bakery & Café!")).toBe('bella-s-bakery-cafe');
    expect(slugify('***')).toBe('item');
  });
  it('finds the next business opening in the client timezone', () => {
    const next = nextBusinessOpening({ monday: [{ start: '09:00', end: '17:00' }] }, 'UTC', new Date('2026-09-20T12:00:00Z')); // Sunday
    expect(next?.toISOString()).toBe('2026-09-21T09:00:00.000Z');
  });
});
