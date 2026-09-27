import { getInfra, readinessReport } from '@socialpilot/core';
import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth';
import { contentRoutes, localMediaRoutes } from './content';
import { adminRoutes, aiSettingsRoutes, analyticsRoutes, automationRoutes, crmRoutes, inboxRoutes, knowledgeRoutes } from './engagement';
import { leadCaptureRoutes, passwordResetRoutes, platformSettingsRoutes, stripeWebhookRoutes } from './leads';
import { organizationRoutes } from './organization';
import { socialRoutes, webhookRoutes } from './social';

export async function registerRoutes(app: FastifyInstance) {
  /** The API has no UI: send browsers to the web app, give API clients pointers. */
  app.get('/', { schema: { hide: true } }, async (req, reply) => {
    const { env } = getInfra();
    if ((req.headers.accept ?? '').includes('text/html')) return reply.redirect(env.APP_URL);
    return { name: 'SocialPilot AI API', app: env.APP_URL, docs: `${env.API_URL}/docs`, health: '/health', ready: '/ready', api: '/api/v1' };
  });

  /** Liveness: the process is up. */
  app.get('/health', { schema: { tags: ['health'] } }, async () => ({ status: 'ok', time: new Date().toISOString() }));

  /** Readiness: database, redis, storage and worker heartbeat. */
  app.get('/ready', { schema: { tags: ['health'] } }, async (_req, reply) => {
    const report = await readinessReport();
    return reply.status(report.status === 'down' ? 503 : 200).send(report);
  });

  await app.register(webhookRoutes);
  await app.register(stripeWebhookRoutes);
  await app.register(localMediaRoutes);
  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(organizationRoutes);
      await v1.register(socialRoutes);
      await v1.register(contentRoutes);
      await v1.register(inboxRoutes);
      await v1.register(crmRoutes);
      await v1.register(knowledgeRoutes);
      await v1.register(automationRoutes);
      await v1.register(analyticsRoutes);
      await v1.register(aiSettingsRoutes);
      await v1.register(adminRoutes);
      await v1.register(leadCaptureRoutes);
      await v1.register(passwordResetRoutes);
      await v1.register(platformSettingsRoutes);
    },
    { prefix: '/api/v1' },
  );
}
