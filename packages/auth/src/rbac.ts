/**
 * Role-based access control. This matrix is the single source of truth; the
 * Role/Permission tables are seeded from it for reporting and future custom roles.
 */

export const ROLE_KEYS = [
  'SUPER_ADMIN',
  'ORG_OWNER',
  'ORG_ADMIN',
  'MANAGER',
  'CONTENT_MANAGER',
  'SOCIAL_MEDIA_MANAGER',
  'CLIENT',
  'APPROVER',
  'VIEWER',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const PERMISSIONS = {
  'content:view': 'View content, calendar and approvals',
  'content:create': 'Create content and generate AI content',
  'content:edit': 'Edit content and variants',
  'content:delete': 'Delete content',
  'content:approve': 'Approve, reject or request changes on content',
  'content:publish': 'Schedule and publish content',
  'messages:view': 'View the unified inbox',
  'messages:reply': 'Send replies and approve AI suggestions',
  'messages:auto_reply': 'Configure automatic replies',
  'messages:assign': 'Assign and escalate conversations',
  'social_accounts:view': 'View connected social accounts',
  'social_accounts:connect': 'Connect social accounts',
  'social_accounts:disconnect': 'Disconnect social accounts',
  'analytics:view': 'View analytics and reports',
  'clients:view': 'View client workspaces',
  'clients:create': 'Create client workspaces',
  'clients:edit': 'Edit client workspaces, brand and AI settings',
  'clients:delete': 'Archive client workspaces',
  'leads:view': 'View leads and contacts',
  'leads:manage': 'Create, assign and update leads and contacts',
  'knowledge:view': 'View the knowledge base',
  'knowledge:manage': 'Add and remove knowledge sources',
  'automation:view': 'View automation rules',
  'automation:manage': 'Create and edit automation rules',
  'users:view': 'View organization members',
  'users:manage': 'Invite members and change roles',
  'settings:manage': 'Manage organization settings',
  'audit:view': 'View audit logs',
  'billing:manage': 'Manage plan and billing',
  'admin:access': 'Platform super-admin area',
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const VIEW_ONLY: Permission[] = [
  'content:view',
  'messages:view',
  'social_accounts:view',
  'analytics:view',
  'clients:view',
  'leads:view',
  'knowledge:view',
  'automation:view',
];

const except = (...excluded: Permission[]) => ALL_PERMISSIONS.filter((p) => !excluded.includes(p));

export const ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  ORG_OWNER: except('admin:access'),
  ORG_ADMIN: except('admin:access', 'billing:manage'),
  MANAGER: except('admin:access', 'billing:manage', 'settings:manage', 'users:manage', 'clients:delete'),
  CONTENT_MANAGER: [
    'content:view',
    'content:create',
    'content:edit',
    'content:delete',
    'content:publish',
    'social_accounts:view',
    'analytics:view',
    'clients:view',
    'knowledge:view',
    'knowledge:manage',
  ],
  SOCIAL_MEDIA_MANAGER: [
    'content:view',
    'content:create',
    'content:edit',
    'content:publish',
    'messages:view',
    'messages:reply',
    'messages:assign',
    'social_accounts:view',
    'social_accounts:connect',
    'analytics:view',
    'clients:view',
    'leads:view',
    'leads:manage',
    'knowledge:view',
    'automation:view',
  ],
  APPROVER: ['content:view', 'content:approve', 'clients:view', 'analytics:view'],
  CLIENT: ['content:view', 'content:approve', 'clients:view', 'analytics:view', 'leads:view', 'messages:view'],
  VIEWER: VIEW_ONLY,
};

/** Roles that can always see every client in their organization. */
export const ALL_CLIENT_ROLES: readonly RoleKey[] = ['SUPER_ADMIN', 'ORG_OWNER', 'ORG_ADMIN'];

/** Default clientAccess for a newly invited member of this role. */
export function defaultClientAccess(role: RoleKey): 'ALL' | 'ASSIGNED' {
  return role === 'CLIENT' || role === 'APPROVER' || role === 'VIEWER' ? 'ASSIGNED' : 'ALL';
}

export function roleHasPermission(role: RoleKey, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsForRole(role: RoleKey): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** Numeric rank used to stop members from granting roles above their own. */
const ROLE_RANK: Record<RoleKey, number> = {
  SUPER_ADMIN: 100,
  ORG_OWNER: 90,
  ORG_ADMIN: 80,
  MANAGER: 60,
  CONTENT_MANAGER: 40,
  SOCIAL_MEDIA_MANAGER: 40,
  APPROVER: 20,
  CLIENT: 10,
  VIEWER: 10,
};

export function canAssignRole(actor: RoleKey, target: RoleKey): boolean {
  if (target === 'SUPER_ADMIN') return false; // platform-level only, never via org membership
  if (actor === 'ORG_OWNER' || actor === 'SUPER_ADMIN') return true;
  return ROLE_RANK[actor] > ROLE_RANK[target];
}
