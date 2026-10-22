/**
 * Fresh demo data for recording or judging, without losing the AI keys saved in
 * Settings → AI models (a plain reseed deletes them with the old demo agency).
 *
 *   npm run demo:reset
 *
 * Keys are held in memory only, never printed or written to disk. Refuses to run
 * in production (the seed does).
 */
import { execFileSync } from 'node:child_process';
import { decryptSecret } from '@socialpilot/auth';
import * as core from '../src/index';

type Provider = 'anthropic' | 'openai' | 'google' | 'nvidia' | 'meta' | 'mock';
type EmbeddingProvider = 'openai' | 'google' | 'nvidia' | 'mock';

async function main() {
  const { db, keyRing } = core.getInfra();
  const old = await db.organization.findUnique({ where: { slug: 'demo-agency' }, include: { aiSettings: true } });
  const row = old?.aiSettings;
  const dec = (field: string, value: string | null | undefined) => (value ? decryptSecret(keyRing, value, `ai-settings:${old!.id}:${field}`) : undefined);
  const saved = row
    ? {
        provider: row.provider as Provider | null,
        model: row.model,
        fastModel: row.fastModel,
        baseUrl: row.baseUrl,
        apiKey: dec('apiKey', row.apiKeyEnc),
        embeddingProvider: row.embeddingProvider as EmbeddingProvider | null,
        embeddingModel: row.embeddingModel,
        embeddingApiKey: dec('embeddingApiKey', row.embeddingApiKeyEnc),
        fallbacks: ((row.fallbacks ?? []) as { provider: Provider; model?: string | null; fastModel?: string | null; apiKeyEnc?: string | null }[]).map((f) => ({
          provider: f.provider,
          model: f.model ?? null,
          fastModel: f.fastModel ?? null,
          apiKey: dec(`fallback:${f.provider}:apiKey`, f.apiKeyEnc) ?? null,
        })),
      }
    : null;
  console.log(saved ? `Keeping AI settings: ${[saved.provider, ...saved.fallbacks.map((f) => f.provider)].filter(Boolean).join(' -> ')}` : 'No saved AI settings to keep.');

  // The seed needs mock social accounts; override only for this child process.
  execFileSync('npm', ['run', 'db:seed', '--', '--force'], { stdio: 'inherit', env: { ...process.env, SOCIAL_MOCK_MODE: 'true' } });

  if (saved) {
    const org = await db.organization.findUniqueOrThrow({ where: { slug: 'demo-agency' } });
    const owner = await db.user.findUniqueOrThrow({ where: { email: 'owner@demo.local' } });
    const ctx = await core.resolveAuthContext({ id: owner.id, isSuperAdmin: false }, org.id);
    await core.updateAiSettings(ctx, {
      provider: saved.provider,
      model: saved.model,
      fastModel: saved.fastModel,
      baseUrl: saved.baseUrl,
      ...(saved.apiKey ? { apiKey: saved.apiKey } : {}),
      embeddingProvider: saved.embeddingProvider,
      embeddingModel: saved.embeddingModel,
      ...(saved.embeddingApiKey ? { embeddingApiKey: saved.embeddingApiKey } : {}),
      fallbacks: saved.fallbacks,
    });
    core.clearAiCache(org.id);
    // Re-index now so replies can use the knowledge base straight away.
    const sources = await db.knowledgeSource.findMany({ where: { organizationId: org.id }, select: { id: true, title: true } });
    for (const s of sources) {
      try {
        await core.processKnowledgeSource(s.id);
      } catch (error) {
        console.warn(`Could not index "${s.title}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`AI settings restored; ${sources.length} knowledge sources indexed.`);
  }
  console.log('Demo is ready. Start it with: npm run demo');
}

main()
  .then(() => core.closeInfra())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await core.closeInfra();
    process.exit(1);
  });
