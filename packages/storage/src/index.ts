import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface StoredObject {
  key: string;
  url: string;
  size: number;
}

/** Provider-neutral object storage. Swap drivers via STORAGE_DRIVER without touching callers. */
export interface StorageProvider {
  readonly driver: 's3' | 'local';
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
  healthCheck(): Promise<boolean>;
}

/** Keys are generated server-side; this rejects traversal or absolute paths defensively. */
export function assertSafeKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\') || /[\u0000-\u001f]/.test(key)) {
    throw new Error('Unsafe storage key');
  }
}

export interface S3Config {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl?: string;
  forcePathStyle?: boolean;
}

export class S3Storage implements StorageProvider {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  publicUrl(key: string): string {
    const base = this.config.publicUrl ?? (this.config.endpoint ? `${this.config.endpoint.replace(/\/$/, '')}/${this.config.bucket}` : `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com`);
    return `${base.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    assertSafeKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: body, ContentType: contentType }));
    return { key, url: this.publicUrl(key), size: body.length };
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error('Empty object body');
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

/** Development-only filesystem driver. Files are served by the API at /media/local/<key>. */
export class LocalStorage implements StorageProvider {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(root: string, private readonly baseUrl: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = normalize(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('Unsafe storage key');
    return full;
  }

  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/media/local/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { key, url: this.publicUrl(key), size: body.length };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true });
      return (await stat(this.root)).isDirectory();
    } catch {
      return false;
    }
  }
}
