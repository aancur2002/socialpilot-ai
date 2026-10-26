import * as core from '@socialpilot/core';
import {
  checkoutSchema,
  startCampaignRunSchema,
  companySettingsSchema,
  createLeadApiKeySchema,
  createLeadFormSchema,
  createLeadWebhookSchema,
  emailSettingsSchema,
  forgotPasswordSchema,
  leadExportQuerySchema,
  legalSettingsSchema,
  resetPasswordWithTokenSchema,
  stripeEnableSchema,
  stripeSettingsSchema,
  testEmailSchema,
  updateLeadFormSchema,
  updateLeadWebhookSchema,
} from '@socialpilot/validation';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { doc, idParam, noContent, parse, requireCtx, requireUser } from '../http';

/** Byte-order mark so Excel opens the CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const formKeyParam = z.object({ key: z.string().regex(/^lf_[A-Za-z0-9_-]{8,40}$/) });

/** Lead capture management (signed in), plus the public form and lead API endpoints. */
export async function leadCaptureRoutes(app: FastifyInstance) {
  // ── Forms ──
  app.get('/lead-forms', { schema: { tags: ['lead capture'] } }, async (req) => core.listLeadForms(await requireCtx(req), parse(z.object({ clientId: z.string().max(64).optional() }), req.query).clientId));
  app.post('/lead-forms', { schema: { tags: ['lead capture'], body: doc(createLeadFormSchema) } }, async (req, reply) => reply.status(201).send(await core.createLeadForm(await requireCtx(req), parse(createLeadFormSchema, req.body))));
  app.get('/lead-forms/:id', { schema: { tags: ['lead capture'] } }, async (req) => core.getLeadForm(await requireCtx(req), parse(idParam, req.params).id));
  app.patch('/lead-forms/:id', { schema: { tags: ['lead capture'], body: doc(updateLeadFormSchema) } }, async (req) => core.updateLeadForm(await requireCtx(req), parse(idParam, req.params).id, parse(updateLeadFormSchema, req.body)));
  app.delete('/lead-forms/:id', { schema: { tags: ['lead capture'] } }, async (req, reply) => {
    await core.deleteLeadForm(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });

  // ── API keys and webhooks ──
  app.get('/lead-api-keys', { schema: { tags: ['lead capture'] } }, async (req) => core.listLeadApiKeys(await requireCtx(req)));
  app.post('/lead-api-keys', { schema: { tags: ['lead capture'], body: doc(createLeadApiKeySchema) } }, async (req, reply) => reply.status(201).send(await core.createLeadApiKey(await requireCtx(req), parse(createLeadApiKeySchema, req.body))));
  app.delete('/lead-api-keys/:id', { schema: { tags: ['lead capture'] } }, async (req, reply) => {
    await core.revokeLeadApiKey(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });
  app.get('/lead-webhooks', { schema: { tags: ['lead capture'] } }, async (req) => core.listLeadWebhooks(await requireCtx(req)));
  app.post('/lead-webhooks', { schema: { tags: ['lead capture'], body: doc(createLeadWebhookSchema) } }, async (req, reply) => reply.status(201).send(await core.createLeadWebhook(await requireCtx(req), parse(createLeadWebhookSchema, req.body))));
  app.patch('/lead-webhooks/:id', { schema: { tags: ['lead capture'], body: doc(updateLeadWebhookSchema) } }, async (req) => core.updateLeadWebhook(await requireCtx(req), parse(idParam, req.params).id, parse(updateLeadWebhookSchema, req.body)));
  app.delete('/lead-webhooks/:id', { schema: { tags: ['lead capture'] } }, async (req, reply) => {
    await core.deleteLeadWebhook(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });
  app.post('/lead-webhooks/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['lead capture'] } }, async (req) => core.testLeadWebhook(await requireCtx(req), parse(idParam, req.params).id));

  // ── CSV export ──
  app.get('/leads/export.csv', { schema: { tags: ['crm'] } }, async (req, reply) => {
    const csv = await core.exportLeadsCsv(await requireCtx(req), parse(leadExportQuerySchema, req.query));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(`${BOM}${csv}`);
  });

  // ── Public: no sign-in. Forms are identified by their public key, the API by a bearer key. ──
  app.get('/public/forms/:key', { schema: { tags: ['public'] } }, async (req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return core.publicFormConfig(parse(formKeyParam, req.params).key);
  });
  app.post('/public/forms/:key/submit', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags: ['public'] } }, async (req) => {
    const origin = req.headers.origin ?? (typeof req.headers.referer === 'string' ? req.headers.referer : undefined);
    return core.submitLeadForm(parse(formKeyParam, req.params).key, (req.body ?? {}) as Record<string, unknown>, { ip: req.ip, origin });
  });
  app.post('/public/leads', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { tags: ['public'] } }, async (req, reply) => {
    const auth = req.headers.authorization;
    const key = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined;
    return reply.status(201).send(await core.ingestLeadViaApi(key, (req.body ?? {}) as Record<string, unknown>));
  });
  app.get('/public/legal', { schema: { tags: ['public'] } }, async () => core.publicLegal());
  app.get('/public/plans', { schema: { tags: ['public'] } }, async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    const [plans, settings] = await Promise.all([core.listPlans(), core.getPlatformSettings()]);
    // Only plans marked public, and only what a visitor needs to compare them.
    return {
      currency: settings.currency,
      allowPublicSignup: settings.allowPublicSignup,
      plans: plans.filter((p) => p.public).map(({ plan, name, description, priceCents, limits }) => ({ plan, name, description, priceCents, limits })),
    };
  });
}

/** Forgot password (signed out). */
export async function passwordResetRoutes(app: FastifyInstance) {
  app.post('/auth/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { tags: ['auth'], body: doc(forgotPasswordSchema) } }, async (req) =>
    core.requestPasswordReset(parse(forgotPasswordSchema, req.body).email, { ip: req.ip, userAgent: req.headers['user-agent'] }),
  );
  app.post('/auth/reset-password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['auth'], body: doc(resetPasswordWithTokenSchema) } }, async (req) =>
    core.resetPasswordWithToken(parse(resetPasswordWithTokenSchema, req.body), { ip: req.ip, userAgent: req.headers['user-agent'] }),
  );
}

/** Platform admin settings groups and the customer-side card checkout. */
export async function platformSettingsRoutes(app: FastifyInstance) {
  const groups = { company: companySettingsSchema, legal: legalSettingsSchema, email: emailSettingsSchema } as const;
  const groupParam = z.object({ group: z.enum(['company', 'legal', 'email', 'stripe']) });
  app.get('/admin/platform/:group', { schema: { tags: ['admin'] } }, async (req) => {
    const { group } = parse(groupParam, req.params);
    const data = await core.adminGetPlatformGroup(requireUser(req), group);
    if (group !== 'stripe') return data;
    const { env } = core.getInfra();
    return { ...data, webhookUrl: `${env.WEBHOOK_BASE_URL ?? env.API_URL}/webhooks/stripe` };
  });
  app.put('/admin/platform/:group', { schema: { tags: ['admin'] } }, async (req) => {
    const user = requireUser(req);
    const { group } = parse(groupParam, req.params);
    if (group === 'stripe') {
      const input = parse(stripeSettingsSchema, req.body);
      // New keys must pass the key check again before card payments can stay on.
      const keysChanged = Object.values(input).some((v) => v !== undefined);
      return core.adminUpdatePlatformGroup(user, 'stripe', keysChanged ? { ...input, enabled: false } : input);
    }
    return core.adminUpdatePlatformGroup(user, group, parse(groups[group], req.body) as never);
  });
  app.post('/admin/platform/email/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { tags: ['admin'], body: doc(testEmailSchema) } }, async (req) => core.sendTestEmail(requireUser(req), parse(testEmailSchema, req.body).to));
  app.post('/admin/platform/stripe/check', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['admin'] } }, async (req) => core.checkStripeKeys(requireUser(req)));
  app.put('/admin/platform/stripe/enabled', { schema: { tags: ['admin'], body: doc(stripeEnableSchema) } }, async (req) => core.setStripeEnabled(requireUser(req), parse(stripeEnableSchema, req.body).enabled));

  app.post('/billing/checkout', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['organizations'], body: doc(checkoutSchema) } }, async (req) => core.createCheckout(await requireCtx(req), parse(checkoutSchema, req.body)));
}

/** Stripe calls this with a signed event (raw body needed for the signature). Refused while card payments are off. */
export async function stripeWebhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/stripe', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    const sig = req.headers['stripe-signature'];
    return core.handleStripeWebhook(req.rawBody ?? Buffer.from(''), typeof sig === 'string' ? sig : undefined);
  });
}

/** Campaign Agent: start a run, follow its timeline, cancel it. */
export async function campaignAgentRoutes(app: FastifyInstance) {
  app.post('/agent/campaigns', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['agent'], body: doc(startCampaignRunSchema) } }, async (req, reply) =>
    reply.status(202).send(await core.startCampaignRun(await requireCtx(req), parse(startCampaignRunSchema, req.body))),
  );
  app.get('/agent/campaigns', { schema: { tags: ['agent'] } }, async (req) => core.listCampaignRuns(await requireCtx(req), parse(z.object({ clientId: z.string().max(64).optional() }), req.query).clientId));
  app.get('/agent/campaigns/:id', { schema: { tags: ['agent'] } }, async (req) => core.getCampaignRun(await requireCtx(req), parse(idParam, req.params).id));
  app.post('/agent/campaigns/:id/cancel', { schema: { tags: ['agent'] } }, async (req, reply) => {
    await core.cancelCampaignRun(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });
}
