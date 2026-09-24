import { readinessReport } from '@socialpilot/core';
import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth';
import { contentRoutes, localMediaRoutes } from './content';
import { adminRoutes, analyticsRoutes, automationRoutes, crmRoutes, inboxRoutes, knowledgeRoutes } from './engagement';
import { organizationRoutes } from './organization';
import { socialRoutes, webhookRoutes } from './social';

export async function registerRoutes(app: FastifyInstance) {
  /** Liveness: the process is up. */
  app.get('/health', { schema: { tags: ['health'] } }, async () => ({ status: 'ok', time: new Date().toISOString() }));

  /** Readiness: database, redis, storage and worker heartbeat. */
  app.get('/ready', { schema: { tags: ['health'] } }, async (_req, reply) => {
    const report = await readinessReport();
    return reply.status(report.status === 'down' ? 503 : 200).send(report);
  });

  await app.register(webhookRoutes);
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
      await v1.register(adminRoutes);
    },
    { prefix: '/api/v1' },
  );
}
