import { DUMMY_PASSWORD_HASH, generateToken, hashPassword, sha256, verifyPassword } from '@socialpilot/auth';
import { isUniqueViolation } from '@socialpilot/database';
import type { LoginInput, RegisterInput } from '@socialpilot/validation';
import { AppError, conflict, forbidden } from '../errors';
import { publicSignupSettings } from './billing.service';
import { getInfra } from '../infra';
import { auditGlobal } from './audit.service';
import { sendEmail } from './email.service';
import { createOrganizationForUser } from './organization.service';
import { getPlatformGroup } from './platform-settings.service';

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
  if (!(await publicSignupSettings()).allowPublicSignup) throw forbidden('Sign-up is closed. Ask your provider for an account.');
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

const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_SECONDS = 15 * 60;
const loginKey = (email: string) => `socialpilot:login-fail:${sha256(email.trim().toLowerCase())}`;

export async function login(input: LoginInput, meta: { ip?: string; userAgent?: string }): Promise<SessionResult> {
  const { db, redis } = getInfra();
  // Per-account lockout on top of the per-IP limit, so guessing from many addresses doesn't work.
  // Keyed by the typed email, so it behaves the same whether or not the account exists.
  const failures = Number(await redis.get(loginKey(input.email))) || 0;
  if (failures >= LOGIN_MAX_FAILURES) {
    throw new AppError('RATE_LIMITED', 'Too many failed sign-ins for this email. Try again in 15 minutes, or reset your password.');
  }
  const user = await db.user.findUnique({ where: { email: input.email } });
  // Always run a hash comparison so response time doesn't reveal whether the email exists.
  const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !user.passwordHash || !valid || user.disabledAt) {
    await auditGlobal({ action: 'user.login_failed', resourceType: 'User', resourceId: user?.id, ip: meta.ip, userAgent: meta.userAgent, after: { email: input.email } });
    const n = await redis.incr(loginKey(input.email));
    if (n === 1) await redis.expire(loginKey(input.email), LOGIN_LOCK_SECONDS);
    throw new AppError('UNAUTHENTICATED', 'Invalid email or password');
  }
  await redis.del(loginKey(input.email));
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

// ── Forgot password ───────────────────────────────────────────────────

const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Emails a one-time reset link. Always succeeds from the caller's point of view,
 * so the form can't be used to find out which emails have accounts.
 */
export async function requestPasswordReset(email: string, meta: { ip?: string; userAgent?: string }) {
  const { db, env, redis } = getInfra();
  const normalized = email.trim().toLowerCase();
  // At most 3 emails per address per hour.
  const key = `socialpilot:rl:pwreset:${sha256(normalized)}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 3600);
  if (n > 3) return { ok: true };
  const user = await db.user.findUnique({ where: { email: normalized }, select: { id: true, name: true, disabledAt: true } });
  if (!user || user.disabledAt) return { ok: true };
  const token = generateToken(32);
  await db.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
  const company = await getPlatformGroup('company');
  const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: normalized,
    subject: `Reset your ${company.productName} password`,
    text: `Hi ${user.name},\n\nSomeone asked to reset your ${company.productName} password. If it was you, choose a new one here:\n${link}\n\nThe link works once and expires in 1 hour. If you didn't ask for this, ignore this email; your password stays the same.`,
  }).catch((error) => getInfra().logger.warn({ userId: user.id, error: error instanceof Error ? error.message : String(error) }, 'password reset email failed'));
  await auditGlobal({ action: 'user.password_reset_requested', resourceType: 'User', resourceId: user.id, userId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true };
}

/** Sets the new password from a reset link and signs the user out everywhere. */
export async function resetPasswordWithToken(input: { token: string; password: string }, meta: { ip?: string; userAgent?: string }) {
  const { db } = getInfra();
  const row = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256(input.token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw new AppError('BAD_REQUEST', 'This reset link is invalid or has expired. Ask for a new one.');
  // Claim the token first so a double submit can't use it twice.
  const claimed = await db.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) throw new AppError('BAD_REQUEST', 'This reset link was already used.');
  await db.$transaction([
    db.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(input.password) } }),
    db.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    db.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  const resetUser = await db.user.findUnique({ where: { id: row.userId }, select: { email: true } });
  if (resetUser) await getInfra().redis.del(loginKey(resetUser.email));
  await auditGlobal({ action: 'user.password_reset', resourceType: 'User', resourceId: row.userId, userId: row.userId, ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true };
}
