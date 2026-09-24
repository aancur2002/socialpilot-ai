import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTENT_STATUSES, INTENTS, LEAD_STATUSES, PLATFORMS, ROLE_KEYS } from './enums';
import { automationActionsSchema, businessHoursSchema, clientSettingsSchema, registerSchema, startOAuthSchema } from './schemas';

const schema = readFileSync(resolve(__dirname, '../../database/prisma/schema.prisma'), 'utf8');
const prismaEnum = (name: string) => {
  const m = new RegExp(`enum ${name} \\{([^}]+)\\}`).exec(schema);
  return m![1]!.split('\n').map((l) => l.trim()).filter(Boolean);
};

describe('enum mirrors stay in sync with schema.prisma', () => {
  it.each([
    ['Platform', PLATFORMS],
    ['RoleKey', ROLE_KEYS],
    ['ContentStatus', CONTENT_STATUSES],
    ['Intent', INTENTS],
    ['LeadStatus', LEAD_STATUSES],
  ] as const)('%s', (name, values) => {
    expect([...values]).toEqual(prismaEnum(name));
  });
});

describe('request schemas', () => {
  it('normalizes emails and enforces password length', () => {
    expect(registerSchema.parse({ name: 'A', email: 'A@B.COM', password: '0123456789' }).email).toBe('a@b.com');
    expect(registerSchema.safeParse({ name: 'A', email: 'a@b.com', password: 'short' }).success).toBe(false);
  });

  it('rejects open redirects in OAuth start', () => {
    expect(startOAuthSchema.safeParse({ clientId: 'c1', platform: 'FACEBOOK', redirectPath: '//evil.com' }).success).toBe(false);
    expect(startOAuthSchema.safeParse({ clientId: 'c1', platform: 'FACEBOOK', redirectPath: 'https://evil.com' }).success).toBe(false);
    expect(startOAuthSchema.safeParse({ clientId: 'c1', platform: 'FACEBOOK', redirectPath: '/clients/c1' }).success).toBe(true);
  });

  it('validates business hours and thresholds', () => {
    expect(businessHoursSchema.safeParse({ monday: [{ start: '09:00', end: '18:00' }] }).success).toBe(true);
    expect(businessHoursSchema.safeParse({ monday: [{ start: '18:00', end: '09:00' }] }).success).toBe(false);
    expect(clientSettingsSchema.safeParse({ autoReplyThreshold: 0.8, approvalThreshold: 0.9 }).success).toBe(false);
  });

  it('validates automation actions', () => {
    expect(automationActionsSchema.safeParse([{ type: 'escalate' }, { type: 'notify' }]).success).toBe(true);
    expect(automationActionsSchema.safeParse([{ type: 'delete_everything' }]).success).toBe(false);
    expect(automationActionsSchema.safeParse([]).success).toBe(false);
  });
});
