#!/usr/bin/env node
// Runs the Prisma CLI with the repo-root .env loaded. Prisma itself only reads a
// .env next to this package, but the monorepo keeps a single .env at the root.
// Variables already set in the environment (CI, Docker) take precedence.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(repoRoot, process.env.ENV_FILE ?? '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) {
  console.error(`DATABASE_URL is not set. Create ${envFile} (cp env.example .env) or export DATABASE_URL.`);
  process.exit(1);
}
const result = spawnSync('npx', ['prisma', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
