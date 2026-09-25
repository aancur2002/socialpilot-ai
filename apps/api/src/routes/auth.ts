import { isProduction } from '@socialpilot/config';
import * as core from '@socialpilot/core';
import { acceptInvitationSchema, changePasswordSchema, createOrganizationSchema, loginSchema, registerSchema, updateProfileSchema } from '@socialpilot/validation';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { doc, parse, requireUser, SESSION_COOKIE } from '../http';

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(core.getInfra().env),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function authRoutes(app: FastifyInstance) {
  const strict = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.post('/auth/register', { ...strict(5), schema: { tags: ['auth'], body: doc(registerSchema) } }, async (req, reply) => {
    const input = parse(registerSchema, req.body);
    const result = await core.register(input, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(reply, result.token, result.expiresAt);
    return reply.status(201).send({ user: result.user, organizationId: result.organizationId ?? null });
  });

  app.post('/auth/login', { ...strict(10), schema: { tags: ['auth'], body: doc(loginSchema) } }, async (req, reply) => {
    const input = parse(loginSchema, req.body);
    const result = await core.login(input, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(reply, result.token, result.expiresAt);
    return { user: result.user };
  });

  app.post('/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    if (req.sessionToken) await core.logout(req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/auth/me', { schema: { tags: ['auth'] } }, async (req) => {
    const user = requireUser(req);
    const organizations = await core.listUserOrganizations(user.id);
    return { user: { id: user.id, email: user.email, name: user.name, isSuperAdmin: user.isSuperAdmin }, organizations };
  });

  app.patch('/auth/me', { schema: { tags: ['auth'], body: doc(updateProfileSchema) } }, async (req) => ({ user: await core.updateProfile(requireUser(req).id, parse(updateProfileSchema, req.body)) }));

  app.post('/auth/password', { ...strict(5), schema: { tags: ['auth'], body: doc(changePasswordSchema) } }, async (req) => {
    const user = requireUser(req);
    return core.changePassword(user.id, user.sessionId, parse(changePasswordSchema, req.body), { ip: req.ip, userAgent: req.headers['user-agent'] });
  });

  app.post('/invitations/accept', { ...strict(10), schema: { tags: ['auth'], body: doc(acceptInvitationSchema) } }, async (req, reply) => {
    const input = parse(acceptInvitationSchema, req.body);
    const result = await core.acceptInvitation(input, req.user ? { id: req.user.id, email: req.user.email } : undefined);
    if (!req.user && input.password) {
      const session = await core.login({ email: (await core.getInfra().db.user.findUniqueOrThrow({ where: { id: result.userId } })).email, password: input.password }, { ip: req.ip, userAgent: req.headers['user-agent'] });
      setSessionCookie(reply, session.token, session.expiresAt);
    }
    return result;
  });

  app.post('/organizations', { schema: { tags: ['organizations'], body: doc(createOrganizationSchema) } }, async (req, reply) => {
    const user = requireUser(req);
    const input = parse(createOrganizationSchema, req.body);
    const org = await core.createOrganizationForUser(user.id, input.name);
    return reply.status(201).send(org);
  });

  app.get('/organizations', { schema: { tags: ['organizations'] } }, async (req) => core.listUserOrganizations(requireUser(req).id));
}
