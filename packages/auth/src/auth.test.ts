import { describe, expect, it } from 'vitest';
import { buildKeyRing, ciphertextKeyVersion, decryptSecret, encryptSecret } from './encryption';
import { hashPassword, verifyPassword } from './password';
import { ALL_PERMISSIONS, canAssignRole, defaultClientAccess, permissionsForRole, roleHasPermission, ROLE_KEYS } from './rbac';
import { createPkcePair, safeEqual, sha256 } from './tokens';

const key = (n: number) => Buffer.alloc(32, n).toString('base64');

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong password!!', hash)).toBe(false);
  });

  it('rejects short passwords and malformed hashes', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
    expect(await verifyPassword('anything', 'bcrypt$nope')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password 1')).not.toEqual(await hashPassword('same password 1'));
  });
});

describe('token encryption (AES-256-GCM)', () => {
  const ring = buildKeyRing(key(1), 1);

  it('round-trips and never contains the plaintext', () => {
    const ct = encryptSecret(ring, 'EAAB-secret-token', 'acct_1');
    expect(ct).not.toContain('EAAB');
    expect(decryptSecret(ring, ct, 'acct_1')).toBe('EAAB-secret-token');
  });

  it('binds ciphertext to its account via associated data', () => {
    const ct = encryptSecret(ring, 'token', 'acct_1');
    expect(() => decryptSecret(ring, ct, 'acct_2')).toThrow();
  });

  it('detects tampering', () => {
    const ct = encryptSecret(ring, 'token', 'a');
    const parts = ct.split(':');
    const data = Buffer.from(parts[3]!, 'base64');
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString('base64');
    expect(() => decryptSecret(ring, parts.join(':'), 'a')).toThrow();
  });

  it('supports key rotation: old ciphertext decrypts with the previous key', () => {
    const old = buildKeyRing(key(1), 1);
    const ct = encryptSecret(old, 'token', 'a');
    const rotated = buildKeyRing(key(2), 2, `1:${key(1)}`);
    expect(ciphertextKeyVersion(ct)).toBe(1);
    expect(decryptSecret(rotated, ct, 'a')).toBe('token');
    expect(ciphertextKeyVersion(encryptSecret(rotated, 'token', 'a'))).toBe(2);
  });

  it('rejects invalid keys', () => {
    expect(() => buildKeyRing(Buffer.alloc(16).toString('base64'), 1)).toThrow();
    expect(() => buildKeyRing(key(1), 1, `1:${key(2)}`)).toThrow(/collides/);
  });
});

describe('RBAC matrix', () => {
  it('gives super admin every permission and owners all but platform admin', () => {
    expect(permissionsForRole('SUPER_ADMIN')).toEqual(ALL_PERMISSIONS);
    expect(roleHasPermission('ORG_OWNER', 'admin:access')).toBe(false);
    expect(roleHasPermission('ORG_OWNER', 'billing:manage')).toBe(true);
  });

  it('keeps viewers read-only', () => {
    const perms = permissionsForRole('VIEWER');
    expect(perms.every((p) => p.endsWith(':view'))).toBe(true);
    expect(roleHasPermission('VIEWER', 'content:create')).toBe(false);
  });

  it('lets approvers and clients approve but not publish', () => {
    for (const role of ['APPROVER', 'CLIENT'] as const) {
      expect(roleHasPermission(role, 'content:approve')).toBe(true);
      expect(roleHasPermission(role, 'content:publish')).toBe(false);
      expect(roleHasPermission(role, 'messages:reply')).toBe(false);
    }
  });

  it('separates content managers from inbox work', () => {
    expect(roleHasPermission('CONTENT_MANAGER', 'content:publish')).toBe(true);
    expect(roleHasPermission('CONTENT_MANAGER', 'messages:view')).toBe(false);
    expect(roleHasPermission('SOCIAL_MEDIA_MANAGER', 'messages:reply')).toBe(true);
    expect(roleHasPermission('SOCIAL_MEDIA_MANAGER', 'messages:auto_reply')).toBe(false);
  });

  it('prevents privilege escalation when assigning roles', () => {
    expect(canAssignRole('ORG_ADMIN', 'ORG_OWNER')).toBe(false);
    expect(canAssignRole('ORG_ADMIN', 'MANAGER')).toBe(true);
    expect(canAssignRole('MANAGER', 'ORG_ADMIN')).toBe(false);
    expect(canAssignRole('ORG_OWNER', 'ORG_OWNER')).toBe(true);
    for (const r of ROLE_KEYS) expect(canAssignRole(r, 'SUPER_ADMIN')).toBe(false);
  });

  it('restricts external roles to assigned clients by default', () => {
    expect(defaultClientAccess('CLIENT')).toBe('ASSIGNED');
    expect(defaultClientAccess('MANAGER')).toBe('ALL');
  });
});

describe('token helpers', () => {
  it('creates a valid S256 PKCE pair', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('compares in constant time and hashes deterministically', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(sha256('x')).toHaveLength(64);
  });
});
