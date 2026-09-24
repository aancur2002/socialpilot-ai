import { z } from 'zod';

// Mirrors of Prisma enums so the browser bundle never imports @prisma/client.
// A unit test asserts these stay in sync with schema.prisma.

export const PLATFORMS = [
  'FACEBOOK',
  'INSTAGRAM',
  'WHATSAPP',
  'LINKEDIN',
  'TIKTOK',
  'YOUTUBE',
  'X',
  'PINTEREST',
  'GOOGLE_BUSINESS',
  'THREADS',
] as const;
export const platformSchema = z.enum(PLATFORMS);
export type PlatformKey = (typeof PLATFORMS)[number];

export const ROLE_KEYS = [
  'SUPER_ADMIN',
  'ORG_OWNER',
  'ORG_ADMIN',
  'MANAGER',
  'CONTENT_MANAGER',
  'SOCIAL_MEDIA_MANAGER',
  'CLIENT',
  'APPROVER',
  'VIEWER',
] as const;
export const roleSchema = z.enum(ROLE_KEYS);

export const CONTENT_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
] as const;
export const contentStatusSchema = z.enum(CONTENT_STATUSES);

export const CONTENT_TYPES = ['POST', 'IMAGE', 'VIDEO', 'CAROUSEL', 'STORY', 'REEL', 'ARTICLE', 'TEXT'] as const;
export const contentTypeSchema = z.enum(CONTENT_TYPES);

export const INTENTS = [
  'GENERAL_QUESTION',
  'PRICE',
  'PRODUCT_INFO',
  'SERVICE_INFO',
  'AVAILABILITY',
  'LOCATION',
  'HOURS',
  'BOOKING',
  'QUOTE_REQUEST',
  'LEAD',
  'COMPLAINT',
  'REFUND',
  'LEGAL',
  'CONTRACT',
  'SPAM',
  'ABUSE',
  'HUMAN_REQUEST',
  'OTHER',
] as const;
export const intentSchema = z.enum(INTENTS);
export type IntentKey = (typeof INTENTS)[number];

export const CONVERSATION_STATUSES = ['OPEN', 'PENDING', 'ESCALATED', 'RESOLVED', 'SPAM'] as const;
export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const prioritySchema = z.enum(PRIORITIES);
export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'APPOINTMENT', 'PROPOSAL', 'WON', 'LOST'] as const;
export const leadStatusSchema = z.enum(LEAD_STATUSES);
export const KNOWLEDGE_SOURCE_TYPES = ['MANUAL', 'FAQ', 'WEBSITE', 'DOCUMENT', 'PDF', 'TEXT', 'PRODUCT', 'SERVICE'] as const;
export const knowledgeSourceTypeSchema = z.enum(KNOWLEDGE_SOURCE_TYPES);
export const AUTOMATION_TRIGGERS = ['MESSAGE_RECEIVED', 'COMMENT_RECEIVED', 'LEAD_CREATED', 'POST_FAILED'] as const;
export const automationTriggerSchema = z.enum(AUTOMATION_TRIGGERS);
export const AFTER_HOURS_MODES = ['REPLY_NORMALLY', 'SEND_AFTER_HOURS_MESSAGE', 'QUEUE_FOR_BUSINESS_HOURS'] as const;
export const afterHoursModeSchema = z.enum(AFTER_HOURS_MODES);

/** Intents that are escalated to a human by default, whatever the confidence. */
export const DEFAULT_ESCALATION_INTENTS: IntentKey[] = ['LEGAL', 'COMPLAINT', 'REFUND', 'CONTRACT', 'ABUSE', 'HUMAN_REQUEST'];
