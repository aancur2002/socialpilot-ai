import * as core from '@socialpilot/core';
import {
  brandProfileSchema,
  clientSettingsSchema,
  createClientSchema,
  inviteMemberSchema,
  updateClientSchema,
  updateMemberSchema,
  updateOrganizationSchema,
} from '@socialpilot/validation';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { doc, idParam, noContent, parse, requireCtx } from '../http';

export async function organizationRoutes(app: FastifyInstance) {
  app.get('/organizations/current', { schema: { tags: ['organizations'] } }, async (req) => {
    const ctx = await requireCtx(req);
    const org = await core.getOrganization(ctx);
    return { ...org, role: ctx.role, permissions: [...ctx.permissions], clientIds: ctx.clientIds, mockMode: core.getInfra().social.mockEnabled, access: await core.organizationAccess(ctx.organizationId) };
  });

  app.get('/billing', { schema: { tags: ['organizations'] } }, async (req) => core.getBilling(await requireCtx(req)));

  app.patch('/organizations/current', { schema: { tags: ['organizations'], body: doc(updateOrganizationSchema) } }, async (req) =>
    core.updateOrganization(await requireCtx(req), parse(updateOrganizationSchema, req.body)),
  );

  app.get('/organizations/current/members', { schema: { tags: ['organizations'] } }, async (req) => core.listMembers(await requireCtx(req)));

  app.post('/organizations/current/invitations', { schema: { tags: ['organizations'], body: doc(inviteMemberSchema) } }, async (req, reply) => {
    const result = await core.inviteMember(await requireCtx(req), parse(inviteMemberSchema, req.body));
    return reply.status(201).send(result);
  });

  app.patch('/organizations/current/members/:id', { schema: { tags: ['organizations'], body: doc(updateMemberSchema) } }, async (req) =>
    core.updateMember(await requireCtx(req), parse(idParam, req.params).id, parse(updateMemberSchema, req.body)),
  );

  app.delete('/organizations/current/members/:id', { schema: { tags: ['organizations'] } }, async (req, reply) => {
    await core.removeMember(await requireCtx(req), parse(idParam, req.params).id);
    return noContent(reply);
  });

  // ── Clients ──
  app.get('/clients', { schema: { tags: ['clients'] } }, async (req) => {
    const q = parse(z.object({ includeArchived: z.coerce.boolean().optional() }), req.query);
    return core.listClients(await requireCtx(req), q);
  });

  app.post('/clients', { schema: { tags: ['clients'], body: doc(createClientSchema) } }, async (req, reply) =>
    reply.status(201).send(await core.createClient(await requireCtx(req), parse(createClientSchema, req.body))),
  );

  app.get('/clients/:id', { schema: { tags: ['clients'] } }, async (req) => core.getClient(await requireCtx(req), parse(idParam, req.params).id));

  app.patch('/clients/:id', { schema: { tags: ['clients'], body: doc(updateClientSchema) } }, async (req) =>
    core.updateClient(await requireCtx(req), parse(idParam, req.params).id, parse(updateClientSchema, req.body)),
  );

  app.put('/clients/:id/brand', { schema: { tags: ['clients'], body: doc(brandProfileSchema) } }, async (req) =>
    core.updateBrandProfile(await requireCtx(req), parse(idParam, req.params).id, parse(brandProfileSchema, req.body)),
  );

  app.patch('/clients/:id/settings', { schema: { tags: ['clients'], body: doc(clientSettingsSchema) } }, async (req) =>
    core.updateClientSettings(await requireCtx(req), parse(idParam, req.params).id, parse(clientSettingsSchema, req.body)),
  );

  app.get('/audit-logs', { schema: { tags: ['audit'] } }, async (req) => {
    const q = parse(z.object({ clientId: z.string().optional(), resourceType: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().optional() }), req.query);
    return core.listAuditLogs(await requireCtx(req), q);
  });

  app.get('/notifications', { schema: { tags: ['notifications'] } }, async (req) => {
    const q = parse(z.object({ unreadOnly: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().optional() }), req.query);
    return core.listNotifications(await requireCtx(req), q);
  });

  app.post('/notifications/read', { schema: { tags: ['notifications'] } }, async (req) => {
    const body = parse(z.object({ ids: z.union([z.array(z.string()).max(200), z.literal('all')]) }), req.body);
    return core.markNotificationsRead(await requireCtx(req), body.ids);
  });
}
