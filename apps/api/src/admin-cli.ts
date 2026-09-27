/**
 * Operator commands inside the production API container:
 *   docker compose -f docker-compose.prod.yml exec api node apps/api/dist/admin-cli.js make-admin you@example.com
 *   … admin-cli.js remove-admin you@example.com
 */
import { closeInfra, getInfra } from '@socialpilot/core';

async function main() {
  const [command, rawEmail] = process.argv.slice(2);
  const email = rawEmail?.trim().toLowerCase();
  if (!email || (command !== 'make-admin' && command !== 'remove-admin')) {
    throw new Error('Usage: node apps/api/dist/admin-cli.js make-admin|remove-admin <email>');
  }
  const { db } = getInfra();
  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No user with email ${email}. Sign up first at /register.`);
  const makeAdmin = command === 'make-admin';
  if (!makeAdmin && (await db.user.count({ where: { isSuperAdmin: true, id: { not: user.id } } })) === 0) throw new Error('Refusing to remove the last platform admin.');
  await db.user.update({ where: { id: user.id }, data: { isSuperAdmin: makeAdmin } });
  await db.auditLog.create({ data: { action: makeAdmin ? 'platform.admin_granted' : 'platform.admin_revoked', resourceType: 'User', resourceId: user.id, userId: user.id, after: { via: 'admin-cli' } } });
  process.stdout.write(`${email} is ${makeAdmin ? 'now' : 'no longer'} a platform admin. Sign out and back in to see the change.\n`);
}

main()
  .then(() => closeInfra())
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await closeInfra();
    process.exit(1);
  });
