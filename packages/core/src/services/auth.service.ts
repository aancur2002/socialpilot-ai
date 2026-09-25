import { DUMMY_PASSWORD_HASH, generateToken, hashPassword, sha256, verifyPassword } from '@socialpilot/auth';
import { isUniqueViolation } from '@socialpilot/database';
import type { LoginInput, RegisterInput } from '@socialpilot/validation';
import { AppError, conflict } from '../errors';
import { getInfra } from '../infra';
import { auditGlobal } from './audit.service';
import { createOrganizationForUser } from './organization.service';

export interface SessionResult {
  token: string;
  expiresAt: Date;
  user: { id: string; email: string; name: string; isSuperAdmin: boolean };
}

async function createSession(userId: string, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; expiresAt: Date }> {
  const { db, env } = getInfra();
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600 * 1000);
  await db.session.create({ data: { userId, tokenHash: sha256(token), ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300), expiresAt } });
  return { token, expiresAt };
}

export async function register(input: RegisterInput, meta: { ip?: string; userAgent?: string }): Promise<SessionResult & { organizationId?: string }> {
  const { db } = getInfra();
  const passwordHash = await hashPassword(input.password);
  let user;
  try {
    user = await db.user.create({ data: { email: input.email, name: input.name, passwordHash } });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('An account with this email already exists');
    throw e;
  }
  let organizationId: string | undefined;
  if (input.organizationName) {
    organizationId = (await createOrganizationForUser(user.id, input.organizationName)).id;
  }
  const session = await createSession(user.id, meta);
  await auditGlobal({ action: 'user.registered', resourceType: 'User', resourceId: user.id, userId: user.id, organizationId, ip: meta.ip, userAgent: meta.userAgent });
  return { ...session, organizationId, user: { id: user.id, email: user.email, name: user.name, isSuperAdmin: user.isSuperAdmin } };
}

export async function login(input: LoginInput, meta: { ip?: string; userAgent?: string }): Promise<SessionResult> {
  const { db } = getInfra();
  const user = await db.user.findUnique({ where: { email: input.email } });
  // Always run a hash comparison so response time doesn't reveal whether the email exists.
  const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !user.passwordHash || !valid || user.disabledAt) {
    await auditGlobal({ action: 'user.login_failed', resourceType: 'User', resourceId: user?.id, ip: meta.ip, userAgent: meta.userAgent, after: { email: input.email } });
    throw new AppError('UNAUTHENTICATED', 'Invalid email or password');
  }
  const session = await createSession(user.id, meta);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await auditGlobal({ action: 'user.login', resourceType: 'User', resourceId: user.id, userId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  return { ...session, user: { id: user.id, email: user.email, name: user.name, isSuperAdmin: user.isSuperAdmin } };
}

export async function logout(token: string): Promise<void> {
  await getInfra().db.session.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  sessionId: string;
}

/** Resolves a session cookie to its user; null when missing, expired, revoked or disabled. */
export async function validateSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const { db } = getInfra();
  const session = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date() || session.user.disabledAt) return null;
  if (Date.now() - session.lastUsedAt.getTime() > 5 * 60 * 1000) {
    await db.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
  }
  return { id: session.user.id, email: session.user.email, name: session.user.name, isSuperAdmin: session.user.isSuperAdmin, sessionId: session.id };
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await getInfra().db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function updateProfile(userId: string, input: { name: string }) {
  const user = await getInfra().db.user.update({ where: { id: userId }, data: { name: input.name }, select: { id: true, email: true, name: true, isSuperAdmin: true } });
  await auditGlobal({ action: 'user.profile_updated', resourceType: 'User', resourceId: userId, userId, after: { name: input.name } });
  return user;
}

/**
 * Changes the password after verifying the current one, then signs out every
 * other session of this user (the current session stays signed in).
 */
export async function changePassword(userId: string, currentSessionId: string, input: { currentPassword: string; newPassword: string }, meta: { ip?: string; userAgent?: string }) {
  const { db } = getInfra();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.passwordHash || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
    await auditGlobal({ action: 'user.password_change_failed', resourceType: 'User', resourceId: userId, userId, ip: meta.ip, userAgent: meta.userAgent });
    throw new AppError('VALIDATION_ERROR', 'Your current password is incorrect', [{ path: 'currentPassword', message: 'Incorrect password' }]);
  }
  await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(input.newPassword) } });
  const revoked = await db.session.updateMany({ where: { userId, revokedAt: null, id: { not: currentSessionId } }, data: { revokedAt: new Date() } });
  await auditGlobal({ action: 'user.password_changed', resourceType: 'User', resourceId: userId, userId, ip: meta.ip, userAgent: meta.userAgent, after: { otherSessionsSignedOut: revoked.count } });
  return { otherSessionsSignedOut: revoked.count };
}
