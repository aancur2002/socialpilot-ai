/**
 * Grants or revokes platform admin (super admin) for an existing user, so the
 * person running the server can add platform app credentials (Meta, LinkedIn,
 * TikTok) from their own login instead of a separate account.
 *
 *   npm run platform-admin -- you@example.com           # grant
 *   npm run platform-admin -- you@example.com --revoke  # revoke
 *
 * Needs shell access to the server, which is the point: it can't be done from the app.
 */
import * as core from '../src/index';

async function main() {
  const email = process.argv.slice(2).find((a) => !a.startsWith('--'))?.trim().toLowerCase();
  const revoke = process.argv.includes('--revoke');
  if (!email) throw new Error('Usage: npm run platform-admin -- <email> [--revoke]');

  const { db } = core.getInfra();
  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No user with email ${email}. Sign up or accept an invitation first.`);
  if (revoke && (await db.user.count({ where: { isSuperAdmin: true, id: { not: user.id } } })) === 0) {
    throw new Error('Refusing to revoke the last platform admin.');
  }
  await db.user.update({ where: { id: user.id }, data: { isSuperAdmin: !revoke } });
  console.log(`${email} is ${revoke ? 'no longer' : 'now'} a platform admin. Sign out and back in to see the change.`);
}

main()
  .then(() => core.closeInfra())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await core.closeInfra();
    process.exit(1);
  });
