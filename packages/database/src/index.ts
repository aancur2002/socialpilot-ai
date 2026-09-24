import { PrismaClient, Prisma } from '@prisma/client';

export * from '@prisma/client';

declare global {
  var __socialpilotPrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

/** Process-wide Prisma client (reused across hot reloads in development). */
export const prisma: PrismaClient = globalThis.__socialpilotPrisma ?? createClient();
if (process.env.NODE_ENV !== 'production') globalThis.__socialpilotPrisma = prisma;

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

export const EMBEDDING_DIMENSIONS = 1536;

/** Serializes an embedding for pgvector (`'[0.1,0.2,...]'::vector`). */
export function toVectorLiteral(values: number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding must have ${EMBEDDING_DIMENSIONS} dimensions, got ${values.length}`);
  }
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error('Embedding contains a non-finite value');
  }
  return `[${values.join(',')}]`;
}

/** Returns true when an error is a Prisma unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
