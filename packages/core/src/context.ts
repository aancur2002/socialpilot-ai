import { ALL_CLIENT_ROLES, permissionsForRole, type Permission, type RoleKey } from '@socialpilot/auth';
import { forbidden, notFound } from './errors';

/**
 * Request-scoped authorization context. Every service method takes one, and
 * every tenant query is built from it — tenant isolation is enforced here, in
 * the service layer, not in the UI.
 */
export interface AuthContext {
  kind: 'user';
  userId: string;
  isSuperAdmin: boolean;
  organizationId: string;
  role: RoleKey;
  permissions: ReadonlySet<Permission>;
  /** null = every client in the organization; otherwise the explicit allow-list */
  clientIds: readonly string[] | null;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

/** Context for background jobs acting on behalf of the system inside one organization. */
export interface SystemContext {
  kind: 'system';
  organizationId: string;
  requestId?: string;
}

export type ServiceContext = AuthContext | SystemContext;

export function buildAuthContext(input: {
  userId: string;
  isSuperAdmin: boolean;
  organizationId: string;
  role: RoleKey;
  clientAccess: 'ALL' | 'ASSIGNED';
  assignedClientIds: string[];
  requestId?: string;
  ip?: string;
  userAgent?: string;
}): AuthContext {
  const role: RoleKey = input.isSuperAdmin ? 'SUPER_ADMIN' : input.role;
  const allClients = ALL_CLIENT_ROLES.includes(role) || input.clientAccess === 'ALL';
  return {
    kind: 'user',
    userId: input.userId,
    isSuperAdmin: input.isSuperAdmin,
    organizationId: input.organizationId,
    role,
    permissions: new Set(permissionsForRole(role)),
    clientIds: allClients ? null : [...input.assignedClientIds],
    requestId: input.requestId,
    ip: input.ip,
    userAgent: input.userAgent,
  };
}

export function systemContext(organizationId: string, requestId?: string): SystemContext {
  return { kind: 'system', organizationId, requestId };
}

export function hasPermission(ctx: ServiceContext, permission: Permission): boolean {
  return ctx.kind === 'system' || ctx.permissions.has(permission);
}

export function requirePermission(ctx: ServiceContext, ...permissions: Permission[]): void {
  for (const p of permissions) {
    if (!hasPermission(ctx, p)) throw forbidden(`Missing permission: ${p}`);
  }
}

export function canAccessClient(ctx: ServiceContext, clientId: string): boolean {
  return ctx.kind === 'system' || ctx.clientIds === null || ctx.clientIds.includes(clientId);
}

/**
 * Throws NOT_FOUND (not FORBIDDEN) for clients outside the caller's scope so the
 * existence of other tenants' resources is never revealed.
 */
export function assertClientAccess(ctx: ServiceContext, clientId: string): void {
  if (!canAccessClient(ctx, clientId)) throw notFound('Client');
}

/**
 * Prisma `where` fragment scoping a query to the caller's organization and the
 * clients they may see. Pass `clientId` to narrow to one client (access-checked).
 */
export function tenantWhere(ctx: ServiceContext, clientId?: string | null): { organizationId: string; clientId?: string | { in: string[] } } {
  if (clientId) {
    assertClientAccess(ctx, clientId);
    return { organizationId: ctx.organizationId, clientId };
  }
  if (ctx.kind === 'user' && ctx.clientIds !== null) {
    return { organizationId: ctx.organizationId, clientId: { in: [...ctx.clientIds] } };
  }
  return { organizationId: ctx.organizationId };
}

export const actorId = (ctx: ServiceContext): string | null => (ctx.kind === 'user' ? ctx.userId : null);
