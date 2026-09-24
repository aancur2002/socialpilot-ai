import { AppError, resolveAuthContext, type AuthContext, type SessionUser } from '@socialpilot/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
    authCtx?: AuthContext;
    rawBody?: Buffer;
    sessionToken?: string;
  }
}

export const SESSION_COOKIE = 'sp_session';
export const ORG_COOKIE = 'sp_org';
export const ORG_HEADER = 'x-organization-id';

/** Parses input with zod; failures become a 422 with field-level issues. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Some fields are invalid',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  return req.user;
}

/**
 * Resolves the organization-scoped authorization context. The organization id
 * comes from the X-Organization-Id header (or the sp_org cookie) and is always
 * checked against the caller's memberships.
 */
export async function requireCtx(req: FastifyRequest): Promise<AuthContext> {
  if (req.authCtx) return req.authCtx;
  const user = requireUser(req);
  const header = req.headers[ORG_HEADER];
  const orgId = (Array.isArray(header) ? header[0] : header) ?? req.cookies[ORG_COOKIE];
  if (!orgId || !/^[a-zA-Z0-9_-]{1,64}$/.test(orgId)) throw new AppError('BAD_REQUEST', 'Select an organization (X-Organization-Id header)');
  req.authCtx = await resolveAuthContext(user, orgId, { requestId: req.id, ip: req.ip, userAgent: req.headers['user-agent'] });
  return req.authCtx;
}

export const idParam = z.object({ id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/) });

export function noContent(reply: FastifyReply) {
  return reply.status(204).send();
}

/** Converts a zod schema into JSON schema for OpenAPI docs only (validation stays in zod). */
export function doc(schema: z.ZodType) {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return {};
  }
}
