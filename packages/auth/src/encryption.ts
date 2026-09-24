import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for secrets at rest (OAuth tokens).
 * Ciphertext format: v<keyVersion>:<ivB64>:<tagB64>:<dataB64>
 * Old key versions stay decryptable during rotation (ENCRYPTION_KEY_PREVIOUS).
 */
export interface KeyRing {
  currentVersion: number;
  keys: Map<number, Buffer>;
}

export function buildKeyRing(currentKeyB64: string, currentVersion: number, previous?: string): KeyRing {
  const keys = new Map<number, Buffer>();
  const current = Buffer.from(currentKeyB64, 'base64');
  if (current.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  keys.set(currentVersion, current);
  if (previous) {
    for (const entry of previous.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = entry.indexOf(':');
      if (idx < 1) throw new Error('ENCRYPTION_KEY_PREVIOUS entries must be "version:base64key"');
      const version = Number(entry.slice(0, idx));
      const key = Buffer.from(entry.slice(idx + 1), 'base64');
      if (!Number.isInteger(version) || key.length !== 32) throw new Error(`Invalid previous encryption key entry for version ${entry.slice(0, idx)}`);
      if (version === currentVersion) throw new Error('Previous key version collides with current version');
      keys.set(version, key);
    }
  }
  return { currentVersion, keys };
}

export function encryptSecret(ring: KeyRing, plaintext: string, aad?: string): string {
  const key = ring.keys.get(ring.currentVersion);
  if (!key) throw new Error('Current encryption key missing');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${ring.currentVersion}:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decryptSecret(ring: KeyRing, ciphertext: string, aad?: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || !parts[0]?.startsWith('v')) throw new Error('Malformed ciphertext');
  const version = Number(parts[0].slice(1));
  const key = ring.keys.get(version);
  if (!key) throw new Error(`No encryption key for version ${version}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(parts[2]!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64')), decipher.final()]).toString('utf8');
}

export function ciphertextKeyVersion(ciphertext: string): number {
  const v = ciphertext.split(':', 1)[0];
  return Number(v?.slice(1));
}
