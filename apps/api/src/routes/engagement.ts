import * as core from '@socialpilot/core';
import {
  analyticsQuerySchema,
  conversationListQuerySchema,
  createAutomationRuleSchema,
  createContactSchema,
  createKnowledgeSourceSchema,
  createLeadSchema,
  escalateSchema,
  generateReportSchema,
  knowledgeSearchSchema,
  leadListQuerySchema,
  leadNoteSchema,
  sendReplySchema,
  updateAutomationRuleSchema,
  updateContactSchema,
  updateConversationSchema,
  updateLeadSchema,
  updateKnowledgeSourceSchema,
  aiSettingsSchema,
  platformSchema,
  platformSetupSchema,
} from '@socialpilot/validation';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { doc, idParam, noContent, parse, requireCtx, requireUser } from '../http';

export async function inboxRoutes(app: FastifyInstance) {
  app.get('/inbox/conversations', { schema: { tags: ['inbox'] } }, async (req) => core.listConversations(await requireCtx(req), parse(conversationListQuerySchema, req.query)));

  app.get('/inbox/conversations/:id', { schema: { tags: ['inbox'] } }, async (req) => core.getConversation(await requireCtx(req), parse(idParam, req.params).id, { markRead: true }));

  app.patch('/inbox/conversations/:id', { schema: { tags: ['inbox'], body: doc(updateConversationSchema) } }, async (req) =>
    core.updateConversation(await requireCtx(req), parse(idParam, req.params).id, parse(updateConversationSchema, req.body)),
  );

  app.post('/inbox/conversations/:id/reply', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags: ['inbox'], body: doc(sendReplySchema) } }, async (req, reply) =>
    reply.status(201).send(await core.replyToConversation(await requireCtx(req), parse(idParam, req.params).id, parse(sendReplySchema, req.body))),
  );

  app.post('/inbox/conversations/:id/escalate', { schema: { tags: ['inbox'], body: doc(escalateSchema) } }, async (req) =>
    core.escalateConversation(await requireCtx(req), parse(idParam, req.params).id, parse(escalateSchema, req.body)),
  );

  app.post('/inbox/conversations/:id/regenerate', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags: ['inbox'] } }, async (req) =>
    core.regenerateSuggestion(await requireCtx(req), parse(idParam, req.params).id),
  );

  app.post('/inbox/conversations/:id/suggestions/:suggestionId/discard', { schema: { tags: ['inbox'] } }, async (req, reply) => {
    const p = parse(z.object({ id: z.string().min(1).max(64), suggestionId: z.string().min(1).max(64) }), req.params);
    await core.discardSuggestion(await requireCtx(req), p.id, p.suggestionId);
    return noContent(reply);
  });

  app.post('/inbox/conversations/:id/lead', { schema: { tags: ['inbox'] } }, async (req, reply) => {
    const ctx = await requireCtx(req);
    const conv = await core.getConversation(ctx, parse(idParam, req.params).id);
    const lead = await core.createLead(ctx, {
      clientId: conv.clientId,
      contactId: conv.contactId,
      conversationId: conv.id,
      name: conv.contact.name,
      username: conv.contact.username,
      platform: conv.platform,
      source: `inbox:${conv.platform.toLowerCase()}`,
      email: conv.contact.email,
      phone: conv.contact.phone,
      interest: conv.lastMessagePreview,
      intent: conv.lastIntent,
      status: 'NEW',
    });
    return reply.status(201).send(lead);
  });

  app.get('/comments', { schema: { tags: ['inbox'] } }, async (req) => {
    const ctx = await requireCtx(req);
    core.requirePermission(ctx, 'messages:view');
    const q = parse(z.object({ clientId: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    return core.getInfra().db.comment.findMany({ where: core.tenantWhere(ctx, q.clientId), orderBy: { createdAt: 'desc' }, take: q.limit, include: { message: { select: { conversationId: true, intent: true } } } });
  });
}

export async function crmRoutes(app: FastifyInstance) {
  app.get('/leads', { schema: { tags: ['crm'] } }, async (req) => core.listLeads(await requireCtx(req), parse(leadListQuerySchema, req.query)));
  app.get('/leads/pipeline', { schema: { tags: ['crm'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional() }), req.query);
    return core.pipeline(await requireCtx(req), q.clientId);
  });
  app.post('/leads', { schema: { tags: ['crm'], body: doc(createLeadSchema) } }, async (req, reply) => reply.status(201).send(await core.createLead(await requireCtx(req), parse(createLeadSchema, req.body))));
  app.get('/leads/:id', { schema: { tags: ['crm'] } }, async (req) => core.getLead(await requireCtx(req), parse(idParam, req.params).id));
  app.patch('/leads/:id', { schema: { tags: ['crm'], body: doc(updateLeadSchema) } }, async (req) => core.updateLead(await requireCtx(req), parse(idParam, req.params).id, parse(updateLeadSchema, req.body)));
  app.post('/leads/:id/notes', { schema: { tags: ['crm'], body: doc(leadNoteSchema) } }, async (req, reply) =>
    reply.status(201).send(await core.addLeadNote(await requireCtx(req), parse(idParam, req.params).id, parse(leadNoteSchema, req.body).body)),
  );

  app.get('/contacts', { schema: { tags: ['crm'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional(), search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().optional() }), req.query);
    return core.listContacts(await requireCtx(req), q);
  });
  app.post('/contacts', { schema: { tags: ['crm'], body: doc(createContactSchema) } }, async (req, reply) => reply.status(201).send(await core.createContact(await requireCtx(req), parse(createContactSchema, req.body))));
  app.get('/contacts/:id', { schema: { tags: ['crm'] } }, async (req) => core.getContact(await requireCtx(req), parse(idParam, req.params).id));
  app.patch('/contacts/:id', { schema: { tags: ['crm'], body: doc(updateContactSchema) } }, async (req) => core.updateContact(await requireCtx(req), parse(idParam, req.params).id, parse(updateContactSchema, req.body)));
}

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get('/knowledge', { schema: { tags: ['knowledge'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().min(1) }), req.query);
    return core.listKnowledgeSources(await requireCtx(req), q.clientId);
  });
  app.post('/knowledge', { schema: { tags: ['knowledge'], body: doc(createKnowledgeSourceSchema) } }, async (req, reply) =>
    reply.status(201).send(await core.createKnowledgeSource(await requireCtx(req), parse(createKnowledgeSourceSchema, req.body))),
  );
  app.get('/knowledge/:id', { schema: { tags: ['knowledge'] } }, async (req) => core.getKnowledgeSource(await requireCtx(req), parse(idParam, req.params).id));
  app.delete('/knowledge/:id', { schema: { tags: ['knowledge'] } }, async (req, reply) => {
    await core.deleteKnowledgeSource(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });
  app.patch('/knowledge/:id', { schema: { tags: ['knowledge'], body: doc(updateKnowledgeSourceSchema) } }, async (req) =>
    core.updateKnowledgeSource(await requireCtx(req), parse(idParam, req.params).id, parse(updateKnowledgeSourceSchema, req.body)),
  );
  app.post('/knowledge/:id/reprocess', { schema: { tags: ['knowledge'] } }, async (req) => core.reprocessKnowledgeSource(await requireCtx(req), parse(idParam, req.params).id));
  app.post('/knowledge/reindex', { schema: { tags: ['knowledge'] } }, async (req) => {
    const body = parse(z.object({ clientId: z.string().optional() }), req.body);
    return core.reindexAllKnowledge(await requireCtx(req), body.clientId);
  });
  app.post('/knowledge/search', { schema: { tags: ['knowledge'], body: doc(knowledgeSearchSchema) } }, async (req) => core.searchKnowledge(await requireCtx(req), parse(knowledgeSearchSchema, req.body)));
}

export async function automationRoutes(app: FastifyInstance) {
  app.get('/automation/rules', { schema: { tags: ['automation'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional() }), req.query);
    return core.listAutomationRules(await requireCtx(req), q.clientId);
  });
  app.post('/automation/rules', { schema: { tags: ['automation'], body: doc(createAutomationRuleSchema) } }, async (req, reply) =>
    reply.status(201).send(await core.createAutomationRule(await requireCtx(req), parse(createAutomationRuleSchema, req.body))),
  );
  app.patch('/automation/rules/:id', { schema: { tags: ['automation'], body: doc(updateAutomationRuleSchema) } }, async (req) =>
    core.updateAutomationRule(await requireCtx(req), parse(idParam, req.params).id, parse(updateAutomationRuleSchema, req.body)),
  );
  app.delete('/automation/rules/:id', { schema: { tags: ['automation'] } }, async (req, reply) => {
    await core.deleteAutomationRule(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });
  app.get('/automation/rules/:id/executions', { schema: { tags: ['automation'] } }, async (req) => core.listAutomationExecutions(await requireCtx(req), parse(idParam, req.params).id));
}

export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/dashboard', { schema: { tags: ['analytics'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional() }), req.query);
    return core.dashboardSummary(await requireCtx(req), q.clientId);
  });
  app.get('/analytics/overview', { schema: { tags: ['analytics'] } }, async (req) => core.analyticsOverview(await requireCtx(req), parse(analyticsQuerySchema, req.query)));
  app.get('/analytics/content', { schema: { tags: ['analytics'] } }, async (req) => core.contentPerformance(await requireCtx(req), parse(analyticsQuerySchema, req.query)));
  app.get('/analytics/platforms', { schema: { tags: ['analytics'] } }, async (req) => core.platformPerformance(await requireCtx(req), parse(analyticsQuerySchema, req.query)));
  app.get('/analytics/leads', { schema: { tags: ['analytics'] } }, async (req) => core.leadPerformance(await requireCtx(req), parse(analyticsQuerySchema, req.query)));
  app.get('/analytics/ai', { schema: { tags: ['analytics'] } }, async (req) => core.aiPerformance(await requireCtx(req), parse(analyticsQuerySchema, req.query)));
  app.get('/analytics/reports', { schema: { tags: ['analytics'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional() }), req.query);
    return core.listReports(await requireCtx(req), q.clientId);
  });
  app.post('/analytics/reports', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['analytics'], body: doc(generateReportSchema) } }, async (req, reply) =>
    reply.status(201).send(await core.generateReport(await requireCtx(req), parse(generateReportSchema, req.body))),
  );
  app.post('/analytics/sync', { schema: { tags: ['analytics'] } }, async (req) => {
    const ctx = await requireCtx(req);
    core.requirePermission(ctx, 'analytics:view');
    const q = parse(z.object({ clientId: z.string().optional() }), req.body);
    const accounts = await core.listSocialAccounts(ctx, q.clientId);
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    for (const a of accounts) {
      if (a.status === 'ACTIVE') await core.getInfra().queues.add('analytics', { socialAccountId: a.id, from: from.toISOString(), to: now.toISOString() });
    }
    return { queued: accounts.filter((a) => a.status === 'ACTIVE').length };
  });
  app.get('/analytics/ai-usage', { schema: { tags: ['analytics'] } }, async (req) => core.aiUsageSummary(await requireCtx(req), parse(analyticsQuerySchema, req.query)));
}

export async function aiSettingsRoutes(app: FastifyInstance) {
  app.get('/ai-settings', { schema: { tags: ['ai'] } }, async (req) => core.getAiSettings(await requireCtx(req)));
  app.put('/ai-settings', { schema: { tags: ['ai'], body: doc(aiSettingsSchema) } }, async (req) => core.updateAiSettings(await requireCtx(req), parse(aiSettingsSchema, req.body)));
  app.post('/ai-settings/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['ai'], body: doc(aiSettingsSchema) } }, async (req) =>
    core.testAiSettings(await requireCtx(req), parse(aiSettingsSchema, req.body)),
  );
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/overview', { schema: { tags: ['admin'] } }, async (req) => core.adminOverview(requireUser(req)));
  app.get('/admin/organizations', { schema: { tags: ['admin'] } }, async (req) => core.adminOrganizations(requireUser(req)));
  app.get('/admin/users', { schema: { tags: ['admin'] } }, async (req) => core.adminUsers(requireUser(req)));
  app.get('/admin/queues', { schema: { tags: ['admin'] } }, async (req) => core.adminQueues(requireUser(req)));
  app.get('/admin/audit-logs', { schema: { tags: ['admin'] } }, async (req) => core.adminAuditLogs(requireUser(req)));
  app.get('/admin/health', { schema: { tags: ['admin'] } }, async (req) => core.adminHealth(requireUser(req)));

  const platformParam = z.object({ platform: z.string().transform((p) => p.toUpperCase()).pipe(platformSchema) });
  app.get('/admin/integrations', { schema: { tags: ['admin'] } }, async (req) => core.listPlatformSetup(requireUser(req)));
  app.put('/admin/integrations/:platform', { schema: { tags: ['admin'], body: doc(platformSetupSchema) } }, async (req) =>
    core.savePlatformSetup(requireUser(req), parse(platformParam, req.params).platform, parse(platformSetupSchema, req.body)),
  );
  app.post('/admin/integrations/:platform/check', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags: ['admin'] } }, async (req) =>
    core.checkPlatformSetup(requireUser(req), parse(platformParam, req.params).platform),
  );
}
