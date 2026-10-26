import { z } from 'zod';
import {
  afterHoursModeSchema,
  automationTriggerSchema,
  contentStatusSchema,
  contentTypeSchema,
  conversationStatusSchema,
  intentSchema,
  knowledgeSourceTypeSchema,
  leadStatusSchema,
  platformSchema,
  prioritySchema,
  roleSchema,
} from './enums';

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();
const stringList = (maxItems: number, maxLen: number) => z.array(z.string().trim().min(1).max(maxLen)).max(maxItems);
export const idSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'invalid id');

// ── Common ──────────────────────────────────────────────────────────────
export const paginationSchema = z.object({
  cursor: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const clientScopedQuerySchema = z.object({ clientId: idSchema.optional() });

// ── Auth ────────────────────────────────────────────────────────────────
export const registerSchema = z.object({
  name: trimmed(120),
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  organizationName: trimmed(120).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ── Organizations & members ─────────────────────────────────────────────
export const createOrganizationSchema = z.object({ name: trimmed(120) });
export const updateOrganizationSchema = z.object({
  name: trimmed(120).optional(),
  onboardingStep: z.string().max(40).optional().nullable(),
});

export const inviteMemberSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  role: roleSchema.exclude(['SUPER_ADMIN']),
  clientIds: z.array(idSchema).max(200).optional(),
});
export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  name: trimmed(120).optional(),
  password: z.string().min(10).max(200).optional(),
});
export const updateMemberSchema = z.object({
  role: roleSchema.exclude(['SUPER_ADMIN']).optional(),
  clientAccess: z.enum(['ALL', 'ASSIGNED']).optional(),
  clientIds: z.array(idSchema).max(200).optional(),
});

// ── Clients ─────────────────────────────────────────────────────────────
export const brandProfileSchema = z.object({
  brandName: trimmed(120),
  industry: optionalText(120),
  description: optionalText(2000),
  tone: optionalText(200),
  targetAudience: optionalText(1000),
  services: stringList(50, 200).default([]),
  products: stringList(100, 200).default([]),
  location: optionalText(300),
  website: z.url().max(500).optional().nullable().or(z.literal('')),
  phone: optionalText(40),
  email: z.email().max(254).optional().nullable().or(z.literal('')),
  brandRules: stringList(50, 500).default([]),
  forbiddenTopics: stringList(50, 200).default([]),
  preferredHashtags: stringList(50, 60).default([]),
  cta: optionalText(200),
});
export type BrandProfileInput = z.infer<typeof brandProfileSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Day = (typeof DAYS)[number];
export const businessHoursSchema = z
  .partialRecord(z.enum(DAYS), z.array(z.object({ start: hhmm, end: hhmm })).max(4))
  .refine((v) => Object.values(v).every((ranges) => (ranges ?? []).every((r) => r.start < r.end)), {
    message: 'Each range must end after it starts',
  });
export type BusinessHours = z.infer<typeof businessHoursSchema>;

export const clientSettingsSchema = z
  .object({
    aiEnabled: z.boolean(),
    autoReplyEnabled: z.boolean(),
    autoPublishEnabled: z.boolean(),
    humanApprovalRequired: z.boolean(),
    defaultTone: optionalText(200),
    defaultLanguage: z.string().min(2).max(10),
    defaultCta: optionalText(200),
    autoReplyThreshold: z.number().min(0.5).max(1),
    approvalThreshold: z.number().min(0).max(1),
    allowedAutoIntents: z.array(intentSchema).max(18),
    escalationIntents: z.array(intentSchema).max(18),
    businessHours: businessHoursSchema,
    afterHoursMode: afterHoursModeSchema,
    afterHoursMessage: optionalText(1000),
    maxPublishAttempts: z.number().int().min(1).max(10).nullable(),
  })
  .partial()
  .refine(
    (v) => v.autoReplyThreshold === undefined || v.approvalThreshold === undefined || v.approvalThreshold <= v.autoReplyThreshold,
    { message: 'approvalThreshold must be ≤ autoReplyThreshold', path: ['approvalThreshold'] },
  );
export type ClientSettingsInput = z.infer<typeof clientSettingsSchema>;

export const createClientSchema = z.object({
  name: trimmed(120),
  timezone: z.string().min(1).max(64).default('UTC'),
  brand: brandProfileSchema.partial().optional(),
});
export const updateClientSchema = z.object({
  name: trimmed(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

// ── Social ──────────────────────────────────────────────────────────────
export const startOAuthSchema = z.object({
  clientId: idSchema,
  platform: platformSchema,
  redirectPath: z.string().max(300).regex(/^\/[^/\\]/, 'must be a relative path').optional(),
  /** A mock account to replace with the real account once the sign-in completes */
  replaceAccountId: idSchema.optional(),
});
export const connectMockSchema = z.object({ clientId: idSchema, platform: platformSchema, displayName: trimmed(120).optional() });

// ── Content ─────────────────────────────────────────────────────────────
export const variantInputSchema = z.object({
  platform: platformSchema,
  socialAccountId: idSchema.optional().nullable(),
  title: optionalText(300),
  caption: z.string().trim().min(1).max(10000),
  hashtags: stringList(60, 100).default([]),
  callToAction: optionalText(300),
  mediaType: z.enum(['none', 'image', 'video', 'carousel', 'document']).optional().nullable(),
  mediaPrompt: optionalText(2000),
  mediaIds: z.array(idSchema).max(20).optional(),
});
export type VariantInput = z.infer<typeof variantInputSchema>;

export const createContentSchema = z.object({
  clientId: idSchema,
  campaignId: idSchema.optional().nullable(),
  title: trimmed(200),
  topic: optionalText(500),
  objective: optionalText(500),
  contentType: contentTypeSchema.default('POST'),
  baseContent: z.string().trim().min(1).max(10000),
  variants: z.array(variantInputSchema).max(10).default([]),
});
export type CreateContentInput = z.infer<typeof createContentSchema>;

export const updateContentSchema = createContentSchema.omit({ clientId: true, variants: true }).partial();
export const updateVariantSchema = variantInputSchema.omit({ platform: true }).partial();

export const generateContentSchema = z.object({
  clientId: idSchema,
  topic: trimmed(500),
  campaignGoal: optionalText(500),
  platforms: z.array(platformSchema).min(1).max(10),
  tone: optionalText(200),
  language: z.string().min(2).max(10).optional(),
  contentType: contentTypeSchema.default('POST'),
  campaignId: idSchema.optional().nullable(),
  additionalInstructions: optionalText(1000),
});
export type GenerateContentInput = z.infer<typeof generateContentSchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
  comment: optionalText(2000),
});

export const scheduleContentSchema = z.object({
  scheduledAt: z.coerce.date(),
  /** Map of variantId → socialAccountId; omitted variants use their assigned account. */
  targets: z.array(z.object({ variantId: idSchema, socialAccountId: idSchema })).max(10).optional(),
});

export const contentListQuerySchema = z.object({
  clientId: idSchema.optional(),
  status: contentStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: idSchema.optional(),
});

// ── Inbox ───────────────────────────────────────────────────────────────
export const conversationListQuerySchema = z.object({
  clientId: idSchema.optional(),
  status: conversationStatusSchema.optional(),
  platform: platformSchema.optional(),
  assignedToMe: z.coerce.boolean().optional(),
  unread: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: idSchema.optional(),
});
export const sendReplySchema = z.object({
  text: z.string().trim().min(1).max(4000),
  suggestionId: idSchema.optional(),
});
export const updateConversationSchema = z.object({
  status: conversationStatusSchema.optional(),
  priority: prioritySchema.optional(),
  assignedToId: idSchema.nullable().optional(),
  mode: z.enum(['AI', 'HUMAN']).optional(),
});
export const escalateSchema = z.object({ reason: trimmed(500) });

// ── CRM ─────────────────────────────────────────────────────────────────
export const createLeadSchema = z.object({
  clientId: idSchema,
  contactId: idSchema.optional().nullable(),
  conversationId: idSchema.optional().nullable(),
  name: optionalText(200),
  username: optionalText(200),
  platform: platformSchema.optional().nullable(),
  source: trimmed(100).default('manual'),
  email: z.email().max(254).optional().nullable().or(z.literal('')),
  phone: optionalText(40),
  interest: optionalText(500),
  intent: intentSchema.optional().nullable(),
  status: leadStatusSchema.default('NEW'),
  value: z.number().nonnegative().max(1e12).optional().nullable(),
  assignedToId: idSchema.optional().nullable(),
});
export const updateLeadSchema = createLeadSchema
  .omit({ clientId: true, conversationId: true, contactId: true, source: true })
  .extend({
    company: optionalText(200),
    message: optionalText(5000),
    tags: z.array(trimmed(40)).max(20).optional(),
    followUpAt: z.coerce.date().optional().nullable(),
    lostReason: optionalText(300),
  })
  .partial();
export const leadNoteSchema = z.object({ body: trimmed(5000) });
export const leadListQuerySchema = z.object({
  clientId: idSchema.optional(),
  status: leadStatusSchema.optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: idSchema.optional(),
});
export const createContactSchema = z.object({
  clientId: idSchema,
  platform: platformSchema,
  platformUserId: optionalText(200),
  name: optionalText(200),
  username: optionalText(200),
  email: z.email().max(254).optional().nullable().or(z.literal('')),
  phone: optionalText(40),
  notes: optionalText(5000),
  tags: stringList(30, 50).default([]),
});
export const updateContactSchema = createContactSchema.omit({ clientId: true, platform: true, platformUserId: true }).partial();

// ── Knowledge ───────────────────────────────────────────────────────────
export const createKnowledgeSourceSchema = z
  .object({
    clientId: idSchema,
    type: knowledgeSourceTypeSchema,
    title: trimmed(300),
    content: z.string().max(500_000).optional(),
    url: z.url().max(2000).optional(),
    mediaId: idSchema.optional(),
  })
  .refine((v) => Boolean(v.content?.trim()) || Boolean(v.url) || Boolean(v.mediaId), {
    message: 'Provide content, a URL, or an uploaded document',
  });
export const knowledgeSearchSchema = z.object({ clientId: idSchema, query: trimmed(1000), limit: z.number().int().min(1).max(20).default(5) });

// ── Automation ──────────────────────────────────────────────────────────
export const CONDITION_FIELDS = ['intent', 'confidence', 'platform', 'isSpam', 'text', 'priority', 'withinBusinessHours', 'conversationType', 'leadDetected'] as const;
export const conditionSchema = z.discriminatedUnion('op', [
  z.object({ field: z.enum(CONDITION_FIELDS), op: z.literal('eq'), value: z.union([z.string().max(200), z.number(), z.boolean()]) }),
  z.object({ field: z.enum(CONDITION_FIELDS), op: z.literal('neq'), value: z.union([z.string().max(200), z.number(), z.boolean()]) }),
  z.object({ field: z.enum(CONDITION_FIELDS), op: z.literal('in'), value: z.array(z.string().max(200)).min(1).max(50) }),
  z.object({ field: z.enum(CONDITION_FIELDS), op: z.literal('not_in'), value: z.array(z.string().max(200)).min(1).max(50) }),
  z.object({ field: z.literal('confidence'), op: z.enum(['gte', 'lte', 'gt', 'lt']), value: z.number().min(0).max(1) }),
  z.object({ field: z.literal('text'), op: z.literal('contains'), value: z.string().min(1).max(200) }),
]);
export type AutomationCondition = z.infer<typeof conditionSchema>;
export const automationConditionsSchema = z.array(conditionSchema).max(20);

export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('generate_reply') }),
  z.object({ type: z.literal('auto_send') }),
  z.object({ type: z.literal('require_approval') }),
  z.object({ type: z.literal('disable_auto_reply') }),
  z.object({ type: z.literal('escalate'), reason: z.string().max(300).optional() }),
  z.object({ type: z.literal('notify'), roles: z.array(roleSchema).max(9).optional(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal('set_priority'), priority: prioritySchema }),
  z.object({ type: z.literal('assign'), userId: idSchema }),
  z.object({ type: z.literal('create_lead') }),
  z.object({ type: z.literal('mark_spam') }),
  z.object({ type: z.literal('add_tag'), tag: z.string().min(1).max(50) }),
  z.object({ type: z.literal('human_takeover') }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;
export const automationActionsSchema = z.array(automationActionSchema).min(1).max(20);

export const createAutomationRuleSchema = z.object({
  clientId: idSchema.nullable().optional(),
  name: trimmed(200),
  description: optionalText(1000),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).default(100),
  trigger: automationTriggerSchema,
  platforms: z.array(platformSchema).max(10).default([]),
  conditions: automationConditionsSchema.default([]),
  actions: automationActionsSchema,
  stopProcessing: z.boolean().default(false),
});
export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export const updateAutomationRuleSchema = createAutomationRuleSchema.partial();

// ── Analytics ───────────────────────────────────────────────────────────
export const analyticsQuerySchema = z.object({
  clientId: idSchema.optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  platform: platformSchema.optional(),
});
export const generateReportSchema = z.object({ clientId: idSchema, from: z.coerce.date(), to: z.coerce.date() });

// ── Campaigns ───────────────────────────────────────────────────────────
export const createCampaignSchema = z.object({
  clientId: idSchema,
  name: trimmed(200),
  goal: optionalText(1000),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
});

// ── Account ─────────────────────────────────────────────────────────────
export const updateProfileSchema = z.object({ name: trimmed(120) });
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(10, 'Use at least 10 characters').max(200),
  })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'Choose a password different from the current one', path: ['newPassword'] });

// ── Knowledge edits ─────────────────────────────────────────────────────
export const updateKnowledgeSourceSchema = z
  .object({ title: trimmed(300).optional(), content: z.string().trim().min(1).max(500_000).optional() })
  .refine((v) => v.title !== undefined || v.content !== undefined, { message: 'Nothing to update' });

// ── AI model settings (per organization) ────────────────────────────────
export const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'nvidia', 'meta', 'mock'] as const;
export const EMBEDDING_PROVIDERS = ['openai', 'google', 'nvidia', 'mock'] as const;
const modelId = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:/@-]+$/, 'Model IDs contain letters, numbers, dots, dashes, slashes or colons');
export const aiSettingsSchema = z.object({
  /** null = use the server default */
  provider: z.enum(AI_PROVIDERS).nullable().optional(),
  model: modelId.nullable().optional(),
  fastModel: modelId.nullable().optional(),
  /** undefined = keep the stored key, null = remove it, string = replace it */
  apiKey: z.string().trim().min(8).max(500).nullable().optional(),
  baseUrl: z.url().max(300).nullable().optional().or(z.literal('')),
  embeddingProvider: z.enum(EMBEDDING_PROVIDERS).nullable().optional(),
  embeddingModel: modelId.nullable().optional(),
  embeddingApiKey: z.string().trim().min(8).max(500).nullable().optional(),
  /**
   * Backup text providers, tried in order when the primary fails. The whole list is
   * replaced; per row, apiKey undefined keeps that provider's saved key, null removes it.
   */
  fallbacks: z
    .array(
      z.object({
        provider: z.enum(AI_PROVIDERS),
        model: modelId.nullable().optional(),
        fastModel: modelId.nullable().optional(),
        apiKey: z.string().trim().min(8).max(500).nullable().optional(),
      }),
    )
    .max(3)
    .optional(),
});
export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;

// ── Platform app credentials (platform admins) ─────────────────────────
const secretField = z.string().trim().min(4).max(500).nullable().optional();
export const platformSetupSchema = z.object({
  clientId: z.string().trim().min(2).max(200).nullable().optional(),
  clientSecret: secretField,
  webhookVerifyToken: secretField,
  configId: z.string().trim().min(2).max(200).nullable().optional(),
  organizationScopes: z.boolean().optional(),
});

// ── SaaS billing (platform admins) ─────────────────────────────────────
export const PLAN_KEYS = ['FREE', 'STARTER', 'PRO', 'AGENCY', 'ENTERPRISE'] as const;
export const LIMIT_KEYS = ['clients', 'socialAccounts', 'members', 'aiGenerations', 'posts', 'messages', 'storageMb'] as const;
const cents = z.number().int().min(0).max(100_000_000);
const limitsSchema = z.partialRecord(z.enum(LIMIT_KEYS), z.number().int().min(0).max(100_000_000));
const optionalDate = z.coerce.date().nullable().optional();

export const platformSettingsSchema = z.object({
  currency: z.string().trim().length(3).toUpperCase().optional(),
  graceDays: z.number().int().min(0).max(90).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  allowPublicSignup: z.boolean().optional(),
  paymentInstructions: z.string().trim().max(2000).nullable().optional(),
});

export const planPriceSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  priceCents: cents.optional(),
  limits: limitsSchema.optional(),
  public: z.boolean().optional(),
});

export const createCustomerSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  plan: z.enum(PLAN_KEYS),
  billingMode: z.enum(['MANUAL', 'COMPLIMENTARY']).default('MANUAL'),
  customPriceCents: cents.nullable().optional(),
  /** Days of free trial; omitted = platform default, 0 = no trial (paid from today) */
  trialDays: z.number().int().min(0).max(365).optional(),
  billingEmail: z.email().max(200).nullable().optional(),
  owner: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.email().max(200).transform((e) => e.toLowerCase()),
    /** Omitted = a strong password is generated and shown once */
    password: z.string().min(10, 'Use at least 10 characters').max(200).optional(),
  }),
});

export const updateCustomerSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  plan: z.enum(PLAN_KEYS).optional(),
  billingMode: z.enum(['MANUAL', 'COMPLIMENTARY']).optional(),
  customPriceCents: cents.nullable().optional(),
  billingEmail: z.email().max(200).nullable().optional(),
  billingNotes: z.string().trim().max(2000).nullable().optional(),
  trialEndsAt: optionalDate,
  paidUntil: optionalDate,
  subscriptionStatus: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'NONE']).optional(),
  suspended: z.boolean().optional(),
  suspendReason: z.string().trim().max(300).nullable().optional(),
  limits: limitsSchema.optional(),
});

export const recordPaymentSchema = z.object({
  amountCents: cents,
  months: z.number().int().min(1).max(36).default(1),
  method: z.enum(['bank_transfer', 'cash', 'card', 'upi', 'paypal', 'other']),
  reference: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(10, 'Use at least 10 characters').max(200).optional(),
});

// ── Lead capture: forms, API keys, webhooks ──────────────────────────
const fieldKey = z.string().trim().min(1).max(40);
export const leadFormFieldSchema = z.object({
  key: fieldKey,
  label: z.string().trim().min(1).max(80),
  type: z.enum(['text', 'email', 'phone', 'textarea', 'select']),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
});
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #0f766e');
export const createLeadFormSchema = z.object({
  clientId: idSchema,
  name: trimmed(80),
  title: optionalText(120),
  description: optionalText(500),
  fields: z.array(leadFormFieldSchema).min(1).max(20),
  submitLabel: trimmed(40).optional(),
  successMessage: trimmed(300).optional(),
  redirectUrl: z.url().max(500).nullable().optional().or(z.literal('').transform(() => null)),
  allowedDomains: z.array(z.string().trim().min(3).max(200)).max(20).optional(),
  notifyEmails: z.array(z.email().max(254)).max(10).optional(),
  accentColor: hexColor.optional(),
  active: z.boolean().optional(),
});
export const updateLeadFormSchema = createLeadFormSchema.omit({ clientId: true }).partial();
export const createLeadApiKeySchema = z.object({ clientId: idSchema, name: trimmed(80) });
const leadEvent = z.enum(['lead.created', 'lead.updated', 'lead.status_changed']);
export const createLeadWebhookSchema = z.object({
  name: trimmed(80),
  url: z.url().max(500),
  clientId: idSchema.nullable().optional(),
  events: z.array(leadEvent).min(1).max(3).optional(),
});
export const updateLeadWebhookSchema = z.object({ name: trimmed(80).optional(), url: z.url().max(500).optional(), events: z.array(leadEvent).min(1).max(3).optional(), active: z.boolean().optional() });
export const leadExportQuerySchema = z.object({ clientId: idSchema.optional(), status: leadStatusSchema.optional() });

// ── Password reset ────────────────────────────────────────────────────
export const forgotPasswordSchema = z.object({ email: z.email().max(254) });
export const resetPasswordWithTokenSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(10, 'Use at least 10 characters').max(200) });

// ── Platform settings (platform admins) ───────────────────────────────
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
export const companySettingsSchema = z.object({
  productName: z.string().trim().min(1).max(60).optional(),
  legalName: nullableText(200),
  address: nullableText(500),
  supportEmail: z.email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
  website: z.url().max(300).nullable().optional().or(z.literal('').transform(() => null)),
  jurisdiction: nullableText(120),
});
export const legalSettingsSchema = z.object({
  terms: nullableText(100_000),
  privacy: nullableText(100_000),
  updatedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export const emailSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  host: nullableText(200),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  user: nullableText(200),
  /** undefined keeps the saved password, '' or null removes it */
  password: z.string().max(500).nullable().optional(),
  fromName: nullableText(100),
  fromEmail: z.email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
});
export const testEmailSchema = z.object({ to: z.email().max(254) });
/** Keys only; switching card payments on goes through the key check. */
export const stripeSettingsSchema = z.object({
  publishableKey: z.string().trim().max(300).nullable().optional(),
  secretKey: z.string().trim().max(300).nullable().optional(),
  webhookSecret: z.string().trim().max(300).nullable().optional(),
});
export const stripeEnableSchema = z.object({ enabled: z.boolean() });
export const checkoutSchema = z.object({ months: z.number().int().min(1).max(24).default(1) });

// ── Campaign Agent ─────────────────────────────────────────────────────
export const startCampaignRunSchema = z.object({
  clientId: idSchema,
  goal: z.string().trim().min(10, 'Describe the goal in a sentence').max(1000),
  /** Calendar day YYYY-MM-DD (time zones don't shift it) */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((d) => new Date(`${d}T00:00:00Z`)).optional(),
  days: z.number().int().min(2).max(30).default(7),
});
