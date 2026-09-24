#!/usr/bin/env node
// Creates a Prisma migration without applying it, then removes the DROP INDEX
// Prisma generates for the pgvector HNSW index (Prisma cannot model that index).
// Usage: npm run migrate:new --workspace @socialpilot/database -- <name>
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Usage: create-migration <snake_case_name>');
  process.exit(1);
}
execFileSync('npx', ['prisma', 'migrate', 'dev', '--create-only', '--name', name], { stdio: 'inherit' });
const dir = join(process.cwd(), 'prisma', 'migrations');
const latest = readdirSync(dir).filter((d) => d.endsWith(`_${name}`)).sort().at(-1);
if (!latest) process.exit(0);
const file = join(dir, latest, 'migration.sql');
const sql = readFileSync(file, 'utf8');
const cleaned = sql.replace(/-- DropIndex\s*\nDROP INDEX "KnowledgeChunk_embedding_hnsw_idx";\s*\n?/g, '');
if (cleaned !== sql) {
  writeFileSync(file, cleaned);
  console.log('Removed generated DROP INDEX for KnowledgeChunk_embedding_hnsw_idx');
}
console.log(`Review ${file}, then run: npm run db:migrate`);
