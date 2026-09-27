'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CustomersPanel, PlansPanel } from './admin-customers';
import { CompanyLegalPanel, EmailPanel, PaymentsPanel } from './admin-settings';
import { IntegrationsSetup } from './integrations-setup';
import { ago, humanize, PlatformChip, when } from '@/components/domain';
import { Badge, EmptyState, ErrorState, PageHeader, Panel, PanelHeader, Skeleton, Table, Tabs, Td, Th } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import type { PlatformKey } from '@/lib/types';

interface Overview {
  totals: Record<string, number>;
  integrations: { platform: PlatformKey; status: string; isMock: boolean; count: number }[];
  aiUsage: { provider: string; status: string; count: number; inputTokens: number; outputTokens: number }[];
  platforms: { platform: PlatformKey; implemented: boolean; configured: boolean; verification: string }[];
}
interface QueueInfo { name: string; counts: Record<string, number>; recentFailures: { id: string; attemptsMade: number; failedReason?: string; timestamp: number }[] }
interface Health { status: string; checks: Record<string, { ok: boolean; latencyMs?: number; detail?: string }> }

type AdminTab = 'overview' | 'customers' | 'plans' | 'company' | 'email' | 'payments' | 'integrations' | 'users' | 'queues' | 'audit';

export function AdminConsole({ enabled, initialTab = 'overview' }: { enabled: boolean; initialTab?: AdminTab }) {
  const [tab, setTab] = useState<AdminTab>(initialTab);
  const overview = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api<Overview>('/admin/overview'), enabled });
  const health = useQuery({ queryKey: ['admin', 'health'], queryFn: () => api<Health>('/admin/health'), enabled, refetchInterval: 15_000 });
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<{ id: string; name: string; email: string; isSuperAdmin: boolean; lastLoginAt: string | null; _count: { memberships: number } }[]>('/admin/users'), enabled: enabled && tab === 'users' });
  const queues = useQuery({ queryKey: ['admin', 'queues'], queryFn: () => api<QueueInfo[]>('/admin/queues'), enabled: enabled && tab === 'queues', refetchInterval: 10_000 });
  const audit = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => api<{ id: string; organizationId: string | null; action: string; resourceType: string; ip: string | null; createdAt: string }[]>('/admin/audit-logs'), enabled: enabled && tab === 'audit' });

  if (!enabled) return <EmptyState title="Platform admins only" />;
  return (
    <>
      <PageHeader title="Platform admin" description="Operational view across all organizations. Customer message contents are deliberately not shown here." />
      {health.data && (
        <div className="mb-6 flex flex-wrap gap-2">
          <Badge tone={health.data.status === 'ok' ? 'clearance' : health.data.status === 'degraded' ? 'runway' : 'alert'}>System {health.data.status}</Badge>
          {Object.entries(health.data.checks).map(([k, v]) => <Badge key={k} tone={v.ok ? 'clearance' : 'alert'} title={v.detail}>{humanize(k)} {v.ok ? `${v.latencyMs}ms` : 'down'}</Badge>)}
        </div>
      )}
      <div className="mb-4"><Tabs value={tab} onChange={setTab} items={[{ value: 'overview', label: 'Overview' }, { value: 'customers', label: 'Customers' }, { value: 'plans', label: 'Plans & billing' }, { value: 'payments', label: 'Payments' }, { value: 'company', label: 'Company & legal' }, { value: 'email', label: 'Email' }, { value: 'integrations', label: 'Integrations' }, { value: 'users', label: 'Users' }, { value: 'queues', label: 'Queues' }, { value: 'audit', label: 'Audit' }]} /></div>
      {tab === 'overview' && (overview.isLoading ? <Skeleton className="h-48" /> : overview.error ? <ErrorState error={overview.error} /> : overview.data && (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Totals" />
            <dl className="grid grid-cols-2 gap-px bg-line">{Object.entries(overview.data.totals).map(([k, v]) => <div key={k} className="bg-surface px-5 py-3"><dt className="text-xs text-ink-3">{humanize(k.replace(/([A-Z])/g, '_$1'))}</dt><dd className="text-lg font-semibold tabular-nums">{v}</dd></div>)}</dl>
          </Panel>
          <Panel>
            <PanelHeader title="Integrations" description="Configured means credentials exist; production use still needs end-to-end verification." />
            <Table>
              <thead><tr><Th>Platform</Th><Th>Server</Th><Th className="text-right">Accounts</Th></tr></thead>
              <tbody>{overview.data.platforms.filter((p) => p.implemented).map((p) => (
                <tr key={p.platform}>
                  <Td><PlatformChip platform={p.platform} withName size="sm" /></Td>
                  <Td>{p.configured ? <Badge tone="sky">Configured, unverified</Badge> : <Badge tone="runway">No credentials</Badge>}</Td>
                  <Td className="text-right tabular-nums">{overview.data!.integrations.filter((i) => i.platform === p.platform).map((i) => `${i.count}${i.isMock ? ' mock' : ''} ${i.status.toLowerCase()}`).join(', ') || '0'}</Td>
                </tr>
              ))}</tbody>
            </Table>
          </Panel>
          <Panel className="lg:col-span-2">
            <PanelHeader title="AI usage, last 30 days" />
            <Table>
              <thead><tr><Th>Provider</Th><Th>Status</Th><Th className="text-right">Calls</Th><Th className="text-right">Input tokens</Th><Th className="text-right">Output tokens</Th></tr></thead>
              <tbody>{overview.data.aiUsage.map((a, i) => <tr key={i}><Td>{a.provider}</Td><Td>{humanize(a.status)}</Td><Td className="text-right tabular-nums">{a.count}</Td><Td className="text-right tabular-nums">{a.inputTokens.toLocaleString()}</Td><Td className="text-right tabular-nums">{a.outputTokens.toLocaleString()}</Td></tr>)}</tbody>
            </Table>
          </Panel>
        </div>
      ))}
      {tab === 'integrations' && <IntegrationsSetup />}
      {tab === 'customers' && <CustomersPanel />}
      {tab === 'plans' && <PlansPanel />}
      {tab === 'payments' && <PaymentsPanel />}
      {tab === 'company' && <CompanyLegalPanel />}
      {tab === 'email' && <EmailPanel />}
      {tab === 'users' && <Panel><Table><thead><tr><Th>User</Th><Th>Organizations</Th><Th>Last sign-in</Th></tr></thead><tbody>{users.data?.map((u) => <tr key={u.id}><Td><span className="font-medium">{u.name}</span> {u.isSuperAdmin && <Badge tone="sky">Admin</Badge>}<p className="text-xs text-ink-3">{u.email}</p></Td><Td className="tabular-nums">{u._count.memberships}</Td><Td className="text-ink-2">{u.lastLoginAt ? ago(u.lastLoginAt) : 'Never'}</Td></tr>)}</tbody></Table></Panel>}
      {tab === 'queues' && (
        <div className="space-y-4">
          {queues.data?.map((q) => (
            <Panel key={q.name}>
              <PanelHeader title={q.name} description={Object.entries(q.counts).map(([k, v]) => `${k} ${v}`).join(', ')} />
              {q.recentFailures.length === 0 ? <p className="px-5 py-3 text-sm text-ink-3">No recent failures.</p> : (
                <ul className="divide-y divide-line">{q.recentFailures.map((f) => <li key={f.id} className="px-5 py-2 text-sm"><span className="text-ink-3">{when(new Date(f.timestamp))}, {f.attemptsMade} attempts: </span>{f.failedReason}</li>)}</ul>
              )}
            </Panel>
          ))}
        </div>
      )}
      {tab === 'audit' && <Panel><Table><thead><tr><Th>When</Th><Th>Action</Th><Th>Resource</Th><Th>Organization</Th><Th>IP</Th></tr></thead><tbody>{audit.data?.map((a) => <tr key={a.id}><Td className="whitespace-nowrap text-ink-2">{when(a.createdAt)}</Td><Td>{a.action}</Td><Td className="text-ink-2">{a.resourceType}</Td><Td className="text-xs text-ink-3">{a.organizationId ?? '—'}</Td><Td className="text-ink-3">{a.ip ?? '—'}</Td></tr>)}</tbody></Table></Panel>}
    </>
  );
}
