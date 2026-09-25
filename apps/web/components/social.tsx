'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Minus, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Capabilities, PlatformStatus, SocialAccount } from '@/lib/types';
import { ago, humanize, MockBadge, PlatformChip, platformName } from './domain';
import { ConfirmButton } from './ui/overlay';
import { Badge, Button, EmptyState, ErrorState, Panel, PanelHeader, Skeleton, Table, Td, Th } from './ui/primitives';

const CAP_COLUMNS: { key: keyof Capabilities; label: string }[] = [
  { key: 'publishing', label: 'Publish' },
  { key: 'imagePublishing', label: 'Images' },
  { key: 'videoPublishing', label: 'Video' },
  { key: 'comments', label: 'Comments' },
  { key: 'commentReplies', label: 'Reply to comments' },
  { key: 'directMessages', label: 'Direct messages' },
  { key: 'analytics', label: 'Analytics' },
];

/** Shows what each official API supports — unsupported features are explicit, never hidden. */
export function CapabilityMatrix({ platforms }: { platforms: PlatformStatus[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Platform</Th>
          {CAP_COLUMNS.map((c) => <Th key={c.key} className="text-center">{c.label}</Th>)}
          <Th>Server setup</Th>
        </tr>
      </thead>
      <tbody>
        {platforms.map((p) => (
          <tr key={p.platform}>
            <Td><PlatformChip platform={p.platform} withName size="sm" /></Td>
            {CAP_COLUMNS.map((c) => (
              <Td key={c.key} className="text-center">
                {p.capabilities[c.key] ? <Check className="mx-auto h-4 w-4 text-clearance" aria-label="Supported" /> : <Minus className="mx-auto h-4 w-4 text-ink-3" aria-label="Not supported by the API" />}
              </Td>
            ))}
            <Td>
              {!p.implemented ? <Badge>Planned</Badge> : p.configured ? <Badge tone="sky" title="Credentials present; verify end-to-end before relying on it in production">Configured, unverified</Badge> : <Badge tone="runway" title={`See ${p.docsPath}`}>Needs credentials</Badge>}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function SocialAccountsPanel({ clientId }: { clientId: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const params = useSearchParams();
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => api<{ mockEnabled: boolean; platforms: PlatformStatus[] }>('/social/platforms') });
  const accounts = useQuery({ queryKey: ['accounts', clientId], queryFn: () => api<SocialAccount[]>('/social/accounts', { query: { clientId } }) });

  useEffect(() => {
    const err = params.get('oauth_error');
    const ok = params.get('connected');
    if (err) toast.error(err);
    else if (ok) toast.success(`Connected ${ok} account${ok === '1' ? '' : 's'}`);
  }, [params]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const connect = useMutation({
    mutationFn: async ({ platform, mock }: { platform: string; mock: boolean }) => {
      if (mock) return api('/social/accounts/mock', { body: { clientId, platform } });
      const r = await api<{ authorizationUrl: string }>('/social/oauth/start', { body: { clientId, platform, redirectPath: `/clients/${clientId}?tab=accounts` } });
      window.location.assign(r.authorizationUrl);
    },
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const refresh = useMutation({ mutationFn: (id: string) => api(`/social/accounts/${id}/refresh`, { body: {} }), onSuccess: invalidate, onError: (e) => toast.error(errorMessage(e)) });

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader title="Connected accounts" description="Tokens are encrypted and never shown in the browser." />
        {accounts.isLoading && <div className="space-y-2 p-4">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>}
        {accounts.error && <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} />}
        {accounts.data?.length === 0 && <EmptyState title="No accounts connected" description="Connect an account below to publish and receive messages." />}
        <ul className="divide-y divide-line">
          {accounts.data?.map((a) => (
            <li key={a.id} className={`strip ${a.status === 'ACTIVE' ? 'strip-clearance' : 'strip-alert'} flex flex-wrap items-center gap-3 px-5 py-3`}>
              <PlatformChip platform={a.platform} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">{a.displayName} {a.isMock && <MockBadge />}</p>
                <p className="text-xs text-ink-3">
                  {a.username ? `@${a.username}, ` : ''}
                  {a.profile?.followers != null ? `${a.profile.followers.toLocaleString()} followers, ` : ''}
                  connected {ago(a.createdAt)}
                  {a.token?.expiresAt ? `, token renews before ${new Date(a.token.expiresAt).toLocaleDateString()}` : ''}
                </p>
                {a.lastError && a.status !== 'ACTIVE' && <p className="text-xs text-alert">{a.lastError}</p>}
              </div>
              <Badge tone={a.status === 'ACTIVE' ? 'clearance' : 'alert'}>{humanize(a.status)}</Badge>
              {a.status !== 'ACTIVE' && can('social_accounts:connect') && (
                <Button size="sm" variant="attention" onClick={() => connect.mutate({ platform: a.platform, mock: a.isMock })}>Reconnect</Button>
              )}
              <Button size="icon" variant="ghost" aria-label="Refresh profile" onClick={() => refresh.mutate(a.id)}><RefreshCw className="h-4 w-4" /></Button>
              {can('social_accounts:disconnect') && (
                <ConfirmButton title={`Disconnect ${a.displayName}?`} description="Credentials are revoked and deleted. Scheduled posts for this account are cancelled." confirmLabel="Disconnect" onConfirm={async () => { await api(`/social/accounts/${a.id}`, { method: 'DELETE' }); invalidate(); toast.success('Disconnected'); }}>
                  Disconnect
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      </Panel>

      {can('social_accounts:connect') && (
        <Panel>
          <PanelHeader title="Connect a platform" description="You’ll sign in on the platform itself; SocialPilot never asks for passwords." />
          <ul className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
            {platforms.data?.platforms.filter((p) => p.implemented).map((p) => (
              <li key={p.platform} className="flex flex-col gap-3 bg-surface p-4">
                <div className="flex items-center gap-2"><PlatformChip platform={p.platform} /><span className="font-medium">{platformName(p.platform)}</span></div>
                <p className="line-clamp-3 text-xs text-ink-2">{p.capabilities.notes[0]}</p>
                <div className="mt-auto flex flex-wrap gap-2">
                  <Button size="sm" disabled={!p.configured} title={p.configured ? undefined : `Add credentials on the server (${p.docsPath})`} onClick={() => connect.mutate({ platform: p.platform, mock: false })}>
                    {p.configured ? 'Connect' : 'Needs server setup'}
                  </Button>
                  {p.mockAvailable && <Button size="sm" variant="secondary" loading={connect.isPending && connect.variables?.platform === p.platform && connect.variables.mock} onClick={() => connect.mutate({ platform: p.platform, mock: true })}>Add mock account</Button>}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {platforms.data && (
        <Panel>
          <PanelHeader title="What each platform allows" description="Based on the official APIs. App review and granted permissions can narrow this further." />
          <CapabilityMatrix platforms={platforms.data.platforms} />
        </Panel>
      )}
    </div>
  );
}
