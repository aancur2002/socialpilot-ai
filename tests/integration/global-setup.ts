import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { TEST_ENV } from './test-env';

/** Applies migrations to the test database and wipes it plus the test Redis db. */
export default async function setup() {
  const env = { ...process.env, ...TEST_ENV };
  execSync('npx prisma migrate deploy', { cwd: 'packages/database', env, stdio: 'pipe' });
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: TEST_ENV.DATABASE_URL } } });
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  await db.$disconnect();
  const redis = new Redis(TEST_ENV.REDIS_URL!);
  await redis.flushdb();
  redis.disconnect();
}
