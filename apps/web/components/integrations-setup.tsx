'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, HelpCircle, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import type { PlatformKey } from '@/lib/types';
import { platformName, PlatformChip, ago } from './domain';
import { Badge, Button, ErrorState, Field, Input, Panel, Skeleton } from './ui/primitives';

interface Setup {
  platform: PlatformKey;
  labels: { clientId: string; clientSecret: string };
  fields: { verifyToken: boolean; configId: boolean; organizationScopes: boolean };
  envPrefix: string;
  clientId: { value: string | null; source: 'dashboard' | 'env' | 'none' };
  clientSecret: { set: boolean; hint: string | null; source: 'dashboard' | 'env' | 'none' };
  webhookVerifyToken: { set: boolean; source: 'dashboard' | 'env' | 'none' };
  configId: { value: string | null; source: 'dashboard' | 'env' | 'none' };
  organizationScopes: boolean;
  configured: boolean;
  lastCheck: { at: string; ok: boolean | null; message: string | null } | null;
  redirectUri: string;
  webhookUrl: string | null;
  scopes: string[];
  docsPath: string;
}

function SourceTag({ source }: { source: 'dashboard' | 'env' | 'none' }) {
  if (source === 'none') return null;
  return <span className="ml-1 text-[11px] font-normal text-ink-3">{source === 'env' ? '(from .env)' : '(saved here)'}</span>;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-ink-2">{label}</p>
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} className="font-[inherit] text-xs" />
        <Button variant="secondary" size="icon" aria-label={`Copy ${label}`} onClick={() => navigator.clipboard.writeText(value).then(() => toast.success('Copied'))}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function PlatformCard({ setup }: { setup: Setup }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ clientId: setup.clientId.source === 'dashboard' ? (setup.clientId.value ?? '') : '', clientSecret: '', webhookVerifyToken: '', configId: setup.configId.source === 'dashboard' ? (setup.configId.value ?? '') : '', organizationScopes: setup.organizationScopes });
  useEffect(() => {
    setF((prev) => ({ ...prev, organizationScopes: setup.organizationScopes }));
  }, [setup.organizationScopes]);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      if (f.clientId.trim()) body.clientId = f.clientId.trim();
      if (f.clientSecret.trim()) body.clientSecret = f.clientSecret.trim();
      if (f.webhookVerifyToken.trim()) body.webhookVerifyToken = f.webhookVerifyToken.trim();
      if (setup.fields.configId && f.configId.trim()) body.configId = f.configId.trim();
      if (setup.fields.organizationScopes) body.organizationScopes = f.organizationScopes;
      return api(`/admin/integrations/${setup.platform.toLowerCase()}`, { method: 'PUT', body });
    },
    onSuccess: (d) => {
      qc.setQueryData(['admin', 'integrations'], d);
      qc.invalidateQueries({ queryKey: ['platforms'] });
      setF((prev) => ({ ...prev, clientSecret: '', webhookVerifyToken: '' }));
      toast.success(`${platformName(setup.platform)} settings saved`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const clear = useMutation({
    mutationFn: () => api(`/admin/integrations/${setup.platform.toLowerCase()}`, { method: 'PUT', body: { clientId: null, clientSecret: null, webhookVerifyToken: null, ...(setup.fields.configId ? { configId: null } : {}) } }),
    onSuccess: (d) => {
      qc.setQueryData(['admin', 'integrations'], d);
      qc.invalidateQueries({ queryKey: ['platforms'] });
      setF({ clientId: '', clientSecret: '', webhookVerifyToken: '', configId: '', organizationScopes: false });
      toast.success('Dashboard values removed; .env values apply again');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const check = useMutation({
    mutationFn: () => api<{ ok: boolean | null; message: string }>(`/admin/integrations/${setup.platform.toLowerCase()}/check`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'integrations'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const last = check.data ? { ok: check.data.ok, message: check.data.message, at: new Date().toISOString() } : setup.lastCheck;
  const hasDashboardValues = setup.clientId.source === 'dashboard' || setup.clientSecret.source === 'dashboard' || setup.webhookVerifyToken.source === 'dashboard' || setup.configId.source === 'dashboard';

  return (
    <Panel id={setup.platform.toLowerCase()} className="scroll-mt-20">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-3">
          <PlatformChip platform={setup.platform} />
          <div>
            <p className="font-semibold">{platformName(setup.platform)}</p>
            <p className="text-xs text-ink-3">Guide: {setup.docsPath}</p>
          </div>
        </div>
        {setup.configured ? <Badge tone="sky">Configured, not yet verified with a live account</Badge> : <Badge tone="runway">Needs credentials</Badge>}
      </div>
      <div className="grid grid-cols-1 gap-6 p-5 lg:grid-cols-2">
        <div className="space-y-4">
          <p className="text-sm font-medium">1. Copy these into the {platformName(setup.platform)} developer console</p>
          <CopyRow label="OAuth redirect URI" value={setup.redirectUri} />
          {setup.webhookUrl && <CopyRow label="Webhook callback URL" value={setup.webhookUrl} />}
          <div className="space-y-1">
            <p className="text-xs font-medium text-ink-2">Permissions (scopes) to request in app review</p>
            <div className="flex flex-wrap gap-1">{setup.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div>
          </div>
          {setup.redirectUri.startsWith('http://localhost') && <p className="text-xs text-runway">Platforms require HTTPS public URLs. Set API_URL and WEBHOOK_BASE_URL to your public domain (or a tunnel) before connecting real accounts.</p>}
        </div>
        <div className="space-y-4">
          <p className="text-sm font-medium">2. Paste the app credentials</p>
          <Field label={setup.labels.clientId} htmlFor={`${setup.platform}-id`}>
            <Input id={`${setup.platform}-id`} value={f.clientId} placeholder={setup.clientId.source === 'env' ? `${setup.clientId.value} (from .env)` : ''} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
          </Field>
          <Field label={setup.labels.clientSecret} htmlFor={`${setup.platform}-secret`} hint={setup.clientSecret.set ? `A secret ending ${setup.clientSecret.hint} is in use${setup.clientSecret.source === 'env' ? ' (from .env)' : ''}. Leave blank to keep it.` : undefined}>
            <Input id={`${setup.platform}-secret`} type="password" autoComplete="off" value={f.clientSecret} placeholder={setup.clientSecret.set ? 'Saved' : ''} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} />
          </Field>
          {setup.fields.verifyToken && (
            <Field label="Webhook verify token" htmlFor={`${setup.platform}-verify`} hint="Any random string. Enter the same value in the webhook settings.">
              <div className="flex gap-2">
                <Input id={`${setup.platform}-verify`} type="password" autoComplete="off" value={f.webhookVerifyToken} placeholder={setup.webhookVerifyToken.set ? 'Saved' : ''} onChange={(e) => setF({ ...f, webhookVerifyToken: e.target.value })} />
                <Button variant="secondary" size="sm" onClick={() => {
                  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
                  setF({ ...f, webhookVerifyToken: token });
                  navigator.clipboard.writeText(token).then(() => toast.success('Generated and copied. Paste it in the webhook settings, then save.'));
                }}>Generate</Button>
              </div>
              <SourceTag source={setup.webhookVerifyToken.source} />
            </Field>
          )}
          {setup.fields.configId && (
            <Field label="Embedded Signup configuration ID" htmlFor={`${setup.platform}-config`}>
              <Input id={`${setup.platform}-config`} value={f.configId} placeholder={setup.configId.source === 'env' ? `${setup.configId.value} (from .env)` : ''} onChange={(e) => setF({ ...f, configId: e.target.value })} />
            </Field>
          )}
          {setup.fields.organizationScopes && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={f.organizationScopes} onChange={(e) => setF({ ...f, organizationScopes: e.target.checked })} />
              <span>Request organization page permissions<span className="block text-xs text-ink-3">Only after LinkedIn approves your app for the Community Management API.</span></span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            <Button variant="secondary" loading={check.isPending} disabled={!setup.configured} onClick={() => check.mutate()}><ShieldCheck className="h-4 w-4" /> Check credentials</Button>
            {hasDashboardValues && <Button variant="ghost" loading={clear.isPending} onClick={() => clear.mutate()}>Remove saved values</Button>}
          </div>
          {last && (
            <p className="flex items-start gap-2 text-sm">
              {last.ok === true ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-clearance" /> : last.ok === false ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-alert" /> : <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />}
              <span>
                {last.message}
                <span className="block text-xs text-ink-3">Checked {ago(last.at)}</span>
              </span>
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function IntegrationsSetup() {
  const q = useQuery({ queryKey: ['admin', 'integrations'], queryFn: () => api<{ mockEnabled: boolean; platforms: Setup[] }>('/admin/integrations') });
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="space-y-6">
      <Panel className="space-y-2 p-5 text-sm">
        <p className="font-medium">How going live works</p>
        <ol className="list-decimal space-y-1 pl-5 text-ink-2">
          <li>Create a developer app on each platform (the guide for each is named on its card).</li>
          <li>Copy the redirect URI and webhook URL below into that app, then paste its credentials here and click Check credentials.</li>
          <li>Agencies can then click Connect in Social accounts. Anyone using a mock account gets a Switch to real account button, which moves its scheduled posts to the real account.</li>
          <li>
            When every platform you need is live, set <code className="rounded bg-surface-2 px-1">SOCIAL_MOCK_MODE=false</code> in .env and restart to remove mock accounts from the product.
            {q.data!.mockEnabled ? ' Mock mode is currently on.' : ' Mock mode is currently off.'}
          </li>
        </ol>
        <p className="text-xs text-ink-3">Values saved here override .env and apply within 30 seconds, no restart needed. Secrets are encrypted and never shown again.</p>
      </Panel>
      {q.data!.platforms.map((p) => <PlatformCard key={p.platform} setup={p} />)}
    </div>
  );
}
