'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CheckCircle2, Plus, PlugZap, Trash2, XCircle } from 'lucide-react';
import { ModelPicker } from './model-picker';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { Badge, Button, ErrorState, Field, Input, Panel, PanelHeader, Select, Skeleton } from './ui/primitives';

interface AiSettingsView {
  saved: {
    provider: string | null;
    model: string | null;
    fastModel: string | null;
    baseUrl: string | null;
    embeddingProvider: string | null;
    embeddingModel: string | null;
    apiKey: { set: boolean; hint: string | null };
    embeddingApiKey: { set: boolean; hint: string | null };
    fallbacks: { provider: string; model: string | null; fastModel: string | null; apiKey: { set: boolean; hint: string | null } }[];
  };
  effective: { provider: string; model: string; fastModel: string; embeddingProvider: string; embeddingModel: string; apiKeySource: 'organization' | 'server' | 'none'; chain: { provider: string; model: string }[] };
  serverDefaults: { provider: string; model: string | null; fastModel: string | null; embeddingProvider: string };
  mockAllowed: boolean;
  suggestions: Record<'anthropic' | 'openai' | 'google' | 'nvidia' | 'meta' | 'baseten' | 'modal', string[]> & { embeddings: Record<'openai' | 'google' | 'nvidia', string[]> };
  reindexRequired?: boolean;
  reindexQueued?: number | null;
}

interface BackupRow {
  provider: string;
  model: string;
  fastModel: string;
  apiKey: string;
  removeKey: boolean;
  saved: { set: boolean; hint: string | null };
}

interface TestResult {
  text: { ok: boolean; model?: string; latencyMs?: number; error?: string };
  chain?: { provider: string; role: 'primary' | 'backup'; ok: boolean; model?: string; latencyMs?: number; error?: string }[];
  embeddings: { ok: boolean; model?: string; dimensions?: number; latencyMs?: number; error?: string };
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI or compatible',
  google: 'Google Gemini',
  nvidia: 'NVIDIA NIM',
  meta: 'Meta Model API (Muse Spark)',
  baseten: 'Baseten (Muse Spark Open, open weights)',
  modal: 'Modal (Muse Glimmer, your own deployment)',
  mock: 'Mock (offline, development only)',
};

/** Where to get a key, shown under the provider picker. */
const KEY_HELP: Record<string, string> = {
  anthropic: 'Create a key at console.anthropic.com.',
  openai: 'Create a key at platform.openai.com, or use your gateway’s key with its base URL.',
  google: 'Free tier available: create a key at aistudio.google.com (Get API key). Free-tier limits are low and prompts may be used to improve Google’s products, so use it for testing.',
  nvidia: 'Free credits available: sign in at build.nvidia.com, open any model and choose Get API Key (keys start with nvapi-). Good for testing Llama, Nemotron, DeepSeek and more.',
  meta: 'Create a key at dev.meta.ai (Meta Model API). Muse Spark writes posts and replies; Meta has no embedding model, so keep Google or NVIDIA below for knowledge search.',
  baseten: 'Meta’s open-weight flagship, hosted by Baseten. Create a key at app.baseten.co (Settings → API keys). Keep Google or NVIDIA below for knowledge search.',
  modal: 'Meta’s open-weight Muse Glimmer on your own Modal GPU. Deploy infra/modal/glimmer.py, then enter its URL as the base URL and the key you set in the Modal secret.',
};

const EMBEDDING_NAMES: Record<string, string> = {
  openai: 'OpenAI embeddings',
  google: 'Google Gemini embeddings',
  nvidia: 'NVIDIA NIM embeddings',
  mock: 'Local word matching (development only)',
};

function KeyField({ id, label, status, value, onChange, remove, onRemove }: { id: string; label: string; status: { set: boolean; hint: string | null }; value: string; onChange: (v: string) => void; remove: boolean; onRemove: (v: boolean) => void }) {
  return (
    <Field label={label} htmlFor={id} hint={status.set ? `A key ending ${status.hint} is saved. Leave blank to keep it.` : 'Leave blank to use the server key from .env, if it matches this provider.'}>
      <Input id={id} type="password" autoComplete="off" placeholder={status.set ? `Saved (${status.hint})` : 'Paste an API key'} value={value} disabled={remove} onChange={(e) => onChange(e.target.value)} />
      {status.set && (
        <label className="mt-1.5 flex items-center gap-2 text-xs text-ink-2">
          <input type="checkbox" checked={remove} onChange={(e) => onRemove(e.target.checked)} /> Remove the saved key
        </label>
      )}
    </Field>
  );
}

export function AiModelSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ai-settings'], queryFn: () => api<AiSettingsView>('/ai-settings') });
  const [f, setF] = useState({ provider: '', model: '', fastModel: '', baseUrl: '', apiKey: '', removeKey: false, embeddingProvider: '', embeddingModel: '', embeddingApiKey: '', removeEmbeddingKey: false });
  const [backups, setBackups] = useState<BackupRow[]>([]);
  /** Live model lists loaded from providers, keyed by "text:provider" or "embedding:provider" */
  const [liveModels, setLiveModels] = useState<Record<string, string[]>>({});
  const loadModels = useMutation({
    mutationFn: (v: { provider: string; apiKey?: string; purpose: 'text' | 'embedding' }) => api<{ models: string[] }>('/ai-settings/models', { body: { provider: v.provider, purpose: v.purpose, ...(v.apiKey?.trim() ? { apiKey: v.apiKey.trim() } : {}) } }),
    onSuccess: (r, v) => {
      setLiveModels((m) => ({ ...m, [`${v.purpose}:${v.provider}`]: r.models }));
      toast.success(r.models.length ? `Loaded ${r.models.length} models from ${PROVIDER_NAMES[v.provider] ?? v.provider}` : 'The provider returned no models for this key');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const modelsFor = (purpose: 'text' | 'embedding', p: string, fallback: string[]) => liveModels[`${purpose}:${p}`] ?? fallback;
  const live = (purpose: 'text' | 'embedding', p: string) => liveModels[`${purpose}:${p}`];
  const isLoading = (purpose: 'text' | 'embedding', p: string) => loadModels.isPending && loadModels.variables?.provider === p && loadModels.variables?.purpose === purpose;
  const [test, setTest] = useState<TestResult | null>(null);
  const [reindex, setReindex] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    const s = q.data.saved;
    setF({ provider: s.provider ?? '', model: s.model ?? '', fastModel: s.fastModel ?? '', baseUrl: s.baseUrl ?? '', apiKey: '', removeKey: false, embeddingProvider: s.embeddingProvider ?? '', embeddingModel: s.embeddingModel ?? '', embeddingApiKey: '', removeEmbeddingKey: false });
    setBackups(s.fallbacks.map((b) => ({ provider: b.provider, model: b.model ?? '', fastModel: b.fastModel ?? '', apiKey: '', removeKey: false, saved: b.apiKey })));
  }, [q.data]);

  const payload = () => ({
    provider: f.provider || null,
    model: f.model.trim() || null,
    fastModel: f.fastModel.trim() || null,
    baseUrl: f.baseUrl.trim() || null,
    embeddingProvider: f.embeddingProvider || null,
    embeddingModel: f.embeddingModel.trim() || null,
    ...(f.removeKey ? { apiKey: null } : f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}),
    ...(f.removeEmbeddingKey ? { embeddingApiKey: null } : f.embeddingApiKey.trim() ? { embeddingApiKey: f.embeddingApiKey.trim() } : {}),
    fallbacks: backups.map((b) => ({
      provider: b.provider,
      model: b.model.trim() || null,
      fastModel: b.fastModel.trim() || null,
      ...(b.removeKey ? { apiKey: null } : b.apiKey.trim() ? { apiKey: b.apiKey.trim() } : {}),
    })),
  });

  const save = useMutation({
    mutationFn: () => api<AiSettingsView>('/ai-settings', { method: 'PUT', body: payload() }),
    onSuccess: (d) => {
      qc.setQueryData(['ai-settings'], d);
      setTest(null);
      setReindex(Boolean(d.reindexRequired));
      toast.success(d.reindexQueued ? `AI settings saved. Re-indexing ${d.reindexQueued} knowledge sources for the new embedding model; it takes a minute or two.` : 'AI settings saved');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const runTest = useMutation({ mutationFn: () => api<TestResult>('/ai-settings/test', { body: payload() }), onSuccess: setTest, onError: (e) => toast.error(errorMessage(e)) });
  const doReindex = useMutation({
    mutationFn: () => api<{ queued: number }>('/knowledge/reindex', { body: {} }),
    onSuccess: (r) => {
      toast.success(`Re-indexing ${r.queued} knowledge sources`);
      setReindex(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const provider = f.provider || d.serverDefaults.provider;
  const suggestions = provider === 'mock' ? [] : modelsFor('text', provider, d.suggestions[provider as 'anthropic'] ?? []);
  const embeddingProvider = f.embeddingProvider || d.serverDefaults.embeddingProvider;
  const allProviders = ['meta', 'baseten', 'modal', 'anthropic', 'openai', 'google', 'nvidia', ...(d.mockAllowed ? ['mock'] : [])];
  const usedBy = (i: number) => new Set([provider, ...backups.filter((_, j) => j !== i).map((b) => b.provider)]);
  const updateBackup = (i: number, patch: Partial<BackupRow>) => setBackups((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const moveBackup = (i: number, dir: -1 | 1) =>
    setBackups((rows) => {
      const next = [...rows];
      const [row] = next.splice(i, 1);
      next.splice(i + dir, 0, row!);
      return next;
    });
  const addBackup = () => {
    // Suggest the free options first.
    const free = ['nvidia', 'google', 'openai', 'anthropic'].find((p) => !usedBy(-1).has(p));
    if (free) setBackups((rows) => [...rows, { provider: free, model: '', fastModel: '', apiKey: '', removeKey: false, saved: { set: false, hint: null } }]);
  };

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader title="Currently in use" description="What content generation, replies, reports and knowledge search use right now." />
        <dl className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-surface px-5 py-3"><dt className="text-xs text-ink-3">Provider</dt><dd className="font-medium">{PROVIDER_NAMES[d.effective.provider] ?? d.effective.provider}</dd></div>
          <div className="bg-surface px-5 py-3"><dt className="text-xs text-ink-3">Main model</dt><dd className="font-medium">{d.effective.model}</dd></div>
          <div className="bg-surface px-5 py-3"><dt className="text-xs text-ink-3">Fast model (classification)</dt><dd className="font-medium">{d.effective.fastModel}</dd></div>
          <div className="bg-surface px-5 py-3"><dt className="text-xs text-ink-3">Embeddings</dt><dd className="font-medium">{d.effective.embeddingModel}</dd></div>
        </dl>
        {d.effective.chain.length > 1 && (
          <p className="border-t border-line px-5 py-3 text-sm">
            <span className="text-ink-3">Tried in order: </span>
            {d.effective.chain.map((c, i) => (
              <span key={c.provider}>
                {i > 0 && <span className="text-ink-3">, then </span>}
                <span className="font-medium">{PROVIDER_NAMES[c.provider] ?? c.provider}</span> <span className="text-ink-3">({c.model})</span>
              </span>
            ))}
          </p>
        )}
        <p className="px-5 py-3 text-xs text-ink-3">
          API key: {d.effective.apiKeySource === 'organization' ? 'saved for this organization' : d.effective.apiKeySource === 'server' ? 'from the server’s .env' : 'none needed (mock provider)'}.
        </p>
      </Panel>

      {reindex && (
        <div className="strip strip-runway flex flex-wrap items-center justify-between gap-3 rounded-r-md bg-runway-soft px-4 py-3 text-sm">
          <span>The embedding model changed. Existing knowledge must be re-indexed before the AI can search it.</span>
          <Button size="sm" variant="attention" loading={doReindex.isPending} onClick={() => doReindex.mutate()}>Re-index knowledge now</Button>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Text generation" description="Used for posts, reply drafts, intent detection, lead extraction and reports." />
          <div className="space-y-4 p-5">
            <Field label="Provider" htmlFor="ai-provider">
              <Select id="ai-provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value, model: '', fastModel: '' })}>
                <option value="">Server default ({PROVIDER_NAMES[d.serverDefaults.provider] ?? d.serverDefaults.provider})</option>
                <option value="meta">{PROVIDER_NAMES.meta}</option>
                <option value="anthropic">{PROVIDER_NAMES.anthropic}</option>
                <option value="openai">{PROVIDER_NAMES.openai}</option>
                <option value="google">{PROVIDER_NAMES.google} (free tier)</option>
                <option value="nvidia">{PROVIDER_NAMES.nvidia} (free credits)</option>
                {d.mockAllowed && <option value="mock">{PROVIDER_NAMES.mock}</option>}
              </Select>
              {KEY_HELP[provider] && <p className="text-xs text-ink-3">{KEY_HELP[provider]}</p>}
            </Field>
            {provider !== 'mock' && (
              <>
                <Field label="Main model" htmlFor="ai-model" hint="Pick from the list or type any model ID your provider offers. Blank uses the provider default.">
                  <ModelPicker id="ai-model" value={f.model} placeholder={suggestions[0] ?? 'model-id'} onChange={(v) => setF({ ...f, model: v })} models={live('text', provider)} loading={isLoading('text', provider)} onLoad={() => loadModels.mutate({ provider, apiKey: f.apiKey, purpose: 'text' })} />
                </Field>
                <Field label="Fast model" htmlFor="ai-fast" hint="Used for quick tasks like intent detection. A smaller model lowers cost. Blank uses the main model.">
                  <ModelPicker id="ai-fast" value={f.fastModel} placeholder={provider === 'meta' ? suggestions[0] : (suggestions[1] ?? '')} onChange={(v) => setF({ ...f, fastModel: v })} models={live('text', provider)} loading={isLoading('text', provider)} onLoad={() => loadModels.mutate({ provider, apiKey: f.apiKey, purpose: 'text' })} />
                </Field>
                <KeyField id="ai-key" label="API key" status={d.saved.apiKey} value={f.apiKey} onChange={(v) => setF({ ...f, apiKey: v })} remove={f.removeKey} onRemove={(v) => setF({ ...f, removeKey: v })} />
                {[provider, ...backups.map((b) => b.provider)].some((p) => p === 'openai' || p === 'modal') && (
                  <Field
                    label="Base URL"
                    htmlFor="ai-base"
                    hint={[provider, ...backups.map((b) => b.provider)].includes('modal') ? 'The URL of your Modal deployment, ending in /v1.' : 'Only for OpenAI-compatible gateways. Blank uses api.openai.com.'}
                  >
                    <Input
                      id="ai-base"
                      value={f.baseUrl}
                      placeholder={[provider, ...backups.map((b) => b.provider)].includes('modal') ? 'https://your-workspace--socialpilot-glimmer-serve.modal.run/v1' : 'https://api.openai.com/v1'}
                      onChange={(e) => setF({ ...f, baseUrl: e.target.value })}
                    />
                  </Field>
                )}
              </>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Knowledge search (embeddings)" description="Turns knowledge into vectors for semantic search. Changing it requires re-indexing." />
          <div className="space-y-4 p-5">
            <Field label="Provider" htmlFor="emb-provider">
              <Select id="emb-provider" value={f.embeddingProvider} onChange={(e) => setF({ ...f, embeddingProvider: e.target.value, embeddingModel: '' })}>
                <option value="">Server default ({EMBEDDING_NAMES[d.serverDefaults.embeddingProvider] ?? d.serverDefaults.embeddingProvider})</option>
                <option value="openai">{EMBEDDING_NAMES.openai}</option>
                <option value="google">{EMBEDDING_NAMES.google} (free tier)</option>
                <option value="nvidia">{EMBEDDING_NAMES.nvidia} (free credits)</option>
                {d.mockAllowed && <option value="mock">{EMBEDDING_NAMES.mock}</option>}
              </Select>
            </Field>
            {embeddingProvider !== 'mock' && (
              <>
                <Field label="Embedding model" htmlFor="emb-model" hint="Vectors up to 1536 dimensions are stored as-is (smaller ones are padded without changing results). Blank uses the provider default.">
                  <ModelPicker id="emb-model" purpose="embedding" value={f.embeddingModel} placeholder={d.suggestions.embeddings[embeddingProvider as 'openai']?.[0] ?? ''} onChange={(v) => setF({ ...f, embeddingModel: v })} models={live('embedding', embeddingProvider)} loading={isLoading('embedding', embeddingProvider)} onLoad={() => loadModels.mutate({ provider: embeddingProvider, apiKey: f.embeddingApiKey, purpose: 'embedding' })} />
                </Field>
                <KeyField id="emb-key" label="Embeddings API key" status={d.saved.embeddingApiKey} value={f.embeddingApiKey} onChange={(v) => setF({ ...f, embeddingApiKey: v })} remove={f.removeEmbeddingKey} onRemove={(v) => setF({ ...f, removeEmbeddingKey: v })} />
                {embeddingProvider === provider && <p className="text-xs text-ink-3">Leave the key blank to reuse the text generation key.</p>}
              </>
            )}
            {embeddingProvider === 'mock' && <p className="text-sm text-ink-2">Local word matching works offline but only finds passages that share words with the question. Use OpenAI embeddings in production.</p>}
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Backup providers"
          description="If the provider above fails (rate limit, used-up free quota, invalid key, outage or unusable answer), the same request goes to the next backup automatically. A provider that just failed is skipped for a minute."
          actions={
            <Button variant="secondary" size="sm" disabled={backups.length >= 3 || allProviders.filter((p) => p !== 'mock').every((p) => usedBy(-1).has(p))} onClick={addBackup}>
              <Plus className="h-4 w-4" /> Add backup
            </Button>
          }
        />
        {backups.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-2">No backups. Add one so replies keep working when a free tier hits its limit, for example Google Gemini first and NVIDIA NIM as backup.</p>
        ) : (
          <ol className="divide-y divide-line">
            {backups.map((b, i) => {
              const options = allProviders.filter((p) => !usedBy(i).has(p));
              const models = b.provider === 'mock' ? [] : modelsFor('text', b.provider, d.suggestions[b.provider as 'anthropic'] ?? []);
              return (
                <li key={`${b.provider}-${i}`} className="grid grid-cols-1 gap-4 px-5 py-4 lg:grid-cols-[auto_1fr_1fr_1fr_auto] lg:items-start">
                  <span className="pt-8 text-sm font-medium text-ink-3">Backup {i + 1}</span>
                  <Field label="Provider" htmlFor={`bk-p-${i}`}>
                    <Select id={`bk-p-${i}`} value={b.provider} onChange={(e) => updateBackup(i, { provider: e.target.value, model: '', fastModel: '', apiKey: '', removeKey: false, saved: { set: false, hint: null } })}>
                      {[b.provider, ...options.filter((o) => o !== b.provider)].map((p) => <option key={p} value={p}>{PROVIDER_NAMES[p] ?? p}</option>)}
                    </Select>
                    {KEY_HELP[b.provider] && <p className="text-xs text-ink-3">{KEY_HELP[b.provider]!.split('. ')[0]!.replace(/\.$/, '')}.</p>}
                  </Field>
                  {b.provider !== 'mock' ? (
                    <>
                      <Field label="Model" htmlFor={`bk-m-${i}`} hint="Blank uses the provider default.">
                        <ModelPicker id={`bk-m-${i}`} value={b.model} placeholder={models[0] ?? ''} onChange={(v) => updateBackup(i, { model: v })} models={live('text', b.provider)} loading={isLoading('text', b.provider)} onLoad={() => loadModels.mutate({ provider: b.provider, apiKey: b.apiKey, purpose: 'text' })} />
                      </Field>
                      <KeyField id={`bk-k-${i}`} label="API key" status={b.saved} value={b.apiKey} onChange={(v) => updateBackup(i, { apiKey: v })} remove={b.removeKey} onRemove={(v) => updateBackup(i, { removeKey: v })} />
                    </>
                  ) : (
                    <p className="pt-8 text-sm text-ink-2 lg:col-span-2">Offline mock provider, useful for trying failover without keys.</p>
                  )}
                  <div className="flex gap-1 lg:pt-6">
                    <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => moveBackup(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === backups.length - 1} onClick={() => moveBackup(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label="Remove backup" onClick={() => setBackups((rows) => rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p className="border-t border-line px-5 py-3 text-xs text-ink-3">Knowledge search doesn’t fail over, because vectors from different models can’t be compared. It can reuse the key of any provider listed here.</p>
      </Panel>

      <Panel className="flex flex-wrap items-center gap-3 p-4">
        <Button variant="secondary" loading={runTest.isPending} onClick={() => runTest.mutate()}><PlugZap className="h-4 w-4" /> Test connection</Button>
        <Button loading={save.isPending} onClick={() => save.mutate()}>Save AI settings</Button>
        <p className="text-xs text-ink-3">The test uses the values on this page without saving them. Keys are encrypted and can’t be viewed again.</p>
        {test && (
          <div className="w-full space-y-1 text-sm">
            {test.chain && test.chain.length > 1 && test.chain.map((c) => (
              <p key={`${c.role}-${c.provider}`} className="flex flex-wrap items-center gap-2">
                {c.ok ? <CheckCircle2 className="h-4 w-4 text-clearance" /> : <XCircle className="h-4 w-4 text-alert" />}
                <span className="font-medium">{c.role === 'primary' ? 'Primary' : 'Backup'}: {PROVIDER_NAMES[c.provider] ?? c.provider}</span>
                {c.model && <Badge>{c.model}</Badge>}
                {c.ok ? <span className="text-ink-2">responded in {c.latencyMs} ms</span> : <span className="text-alert">{c.error}</span>}
              </p>
            ))}
            {(test.chain && test.chain.length > 1 ? (['embeddings'] as const) : (['text', 'embeddings'] as const)).map((k) => (
              <p key={k} className="flex flex-wrap items-center gap-2">
                {test[k].ok ? <CheckCircle2 className="h-4 w-4 text-clearance" /> : <XCircle className="h-4 w-4 text-alert" />}
                <span className="font-medium">{k === 'text' ? 'Text generation' : 'Embeddings'}</span>
                {test[k].model && <Badge>{test[k].model}</Badge>}
                {test[k].ok ? <span className="text-ink-2">responded in {test[k].latencyMs} ms</span> : <span className="text-alert">{test[k].error}</span>}
              </p>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
