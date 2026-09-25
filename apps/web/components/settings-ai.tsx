'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, PlugZap, XCircle } from 'lucide-react';
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
  };
  effective: { provider: string; model: string; fastModel: string; embeddingProvider: string; embeddingModel: string; apiKeySource: 'organization' | 'server' | 'none' };
  serverDefaults: { provider: string; model: string | null; fastModel: string | null; embeddingProvider: string };
  mockAllowed: boolean;
  suggestions: { anthropic: string[]; openai: string[]; embeddings: { openai: string[] } };
  reindexRequired?: boolean;
}

interface TestResult {
  text: { ok: boolean; model?: string; latencyMs?: number; error?: string };
  embeddings: { ok: boolean; model?: string; dimensions?: number; latencyMs?: number; error?: string };
}

const PROVIDER_NAMES: Record<string, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI or compatible', mock: 'Mock (offline, development only)' };

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
  const [test, setTest] = useState<TestResult | null>(null);
  const [reindex, setReindex] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    const s = q.data.saved;
    setF({ provider: s.provider ?? '', model: s.model ?? '', fastModel: s.fastModel ?? '', baseUrl: s.baseUrl ?? '', apiKey: '', removeKey: false, embeddingProvider: s.embeddingProvider ?? '', embeddingModel: s.embeddingModel ?? '', embeddingApiKey: '', removeEmbeddingKey: false });
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
  });

  const save = useMutation({
    mutationFn: () => api<AiSettingsView>('/ai-settings', { method: 'PUT', body: payload() }),
    onSuccess: (d) => {
      qc.setQueryData(['ai-settings'], d);
      setTest(null);
      setReindex(Boolean(d.reindexRequired));
      toast.success('AI settings saved');
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
  const suggestions = provider === 'anthropic' ? d.suggestions.anthropic : provider === 'openai' ? d.suggestions.openai : [];
  const embeddingProvider = f.embeddingProvider || d.serverDefaults.embeddingProvider;

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
                <option value="anthropic">{PROVIDER_NAMES.anthropic}</option>
                <option value="openai">{PROVIDER_NAMES.openai}</option>
                {d.mockAllowed && <option value="mock">{PROVIDER_NAMES.mock}</option>}
              </Select>
            </Field>
            {provider !== 'mock' && (
              <>
                <Field label="Main model" htmlFor="ai-model" hint="Pick a suggestion or type any model ID your provider offers. Blank uses the provider default.">
                  <Input id="ai-model" list="ai-model-options" value={f.model} placeholder={suggestions[0] ?? 'model-id'} onChange={(e) => setF({ ...f, model: e.target.value })} />
                </Field>
                <Field label="Fast model" htmlFor="ai-fast" hint="Used for quick tasks like intent detection. A smaller model lowers cost. Blank uses the main model.">
                  <Input id="ai-fast" list="ai-model-options" value={f.fastModel} onChange={(e) => setF({ ...f, fastModel: e.target.value })} />
                </Field>
                <datalist id="ai-model-options">{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
                <KeyField id="ai-key" label="API key" status={d.saved.apiKey} value={f.apiKey} onChange={(v) => setF({ ...f, apiKey: v })} remove={f.removeKey} onRemove={(v) => setF({ ...f, removeKey: v })} />
                {provider === 'openai' && (
                  <Field label="Base URL" htmlFor="ai-base" hint="Only for OpenAI-compatible gateways. Blank uses api.openai.com.">
                    <Input id="ai-base" value={f.baseUrl} placeholder="https://api.openai.com/v1" onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
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
                <option value="">Server default ({d.serverDefaults.embeddingProvider === 'mock' ? 'local word matching' : 'OpenAI'})</option>
                <option value="openai">OpenAI embeddings</option>
                {d.mockAllowed && <option value="mock">Local word matching (development only)</option>}
              </Select>
            </Field>
            {embeddingProvider === 'openai' && (
              <>
                <Field label="Embedding model" htmlFor="emb-model" hint="Must produce 1536-dimension vectors.">
                  <Input id="emb-model" list="emb-model-options" value={f.embeddingModel} placeholder="text-embedding-3-small" onChange={(e) => setF({ ...f, embeddingModel: e.target.value })} />
                  <datalist id="emb-model-options">{d.suggestions.embeddings.openai.map((m) => <option key={m} value={m} />)}</datalist>
                </Field>
                <KeyField id="emb-key" label="Embeddings API key" status={d.saved.embeddingApiKey} value={f.embeddingApiKey} onChange={(v) => setF({ ...f, embeddingApiKey: v })} remove={f.removeEmbeddingKey} onRemove={(v) => setF({ ...f, removeEmbeddingKey: v })} />
              </>
            )}
            {embeddingProvider === 'mock' && <p className="text-sm text-ink-2">Local word matching works offline but only finds passages that share words with the question. Use OpenAI embeddings in production.</p>}
          </div>
        </Panel>
      </div>

      <Panel className="flex flex-wrap items-center gap-3 p-4">
        <Button variant="secondary" loading={runTest.isPending} onClick={() => runTest.mutate()}><PlugZap className="h-4 w-4" /> Test connection</Button>
        <Button loading={save.isPending} onClick={() => save.mutate()}>Save AI settings</Button>
        <p className="text-xs text-ink-3">The test uses the values on this page without saving them. Keys are encrypted and can’t be viewed again.</p>
        {test && (
          <div className="w-full space-y-1 text-sm">
            {(['text', 'embeddings'] as const).map((k) => (
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
