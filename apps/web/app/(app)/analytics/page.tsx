'use client';

import { ClientSelect } from '@/components/client-select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { day, humanize, MockBadge, PlatformChip, platformName, when } from '@/components/domain';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Panel, PanelHeader, Select, Skeleton, Table, Tabs, Td, Th } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { PlatformKey } from '@/lib/types';

interface Overview {
  posts: { published: number; scheduled: number; failed: number; pendingApprovals: number };
  messages: { inbound: number; outbound: number; aiAutoSent: number; escalations: number; averageFirstResponseMinutes: number | null };
  leads: { created: number };
  platformMetrics: Record<string, number>;
  unavailableMetrics: string[];
  mockDataPresent: boolean;
}
interface ContentPerf { publishedPostId: string; title: string; platform: PlatformKey; account: string; isMock: boolean; publishedAt: string; metrics: Record<string, number>; engagement: number | null }
interface Report { id: string; periodStart: string; periodEnd: string; createdAt: string; summary: { headline: string; summary: string; highlights: string[]; trends: { metric: string; direction: string; observation: string }[]; contentIdeas: string[]; engagementObservations: string[]; leadObservations: string[]; caveats: string[] } }

const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--ink)', fontSize: 12 };
const axisProps = { stroke: 'var(--ink-3)', fontSize: 12, tickLine: false, axisLine: false } as const;

function SingleBar({ data, label }: { data: { name: string; value: number }[]; label: string }) {
  if (!data.length) return <EmptyState title="No data in this period" />;
  return (
    <div className="h-64 px-2 py-4" role="img" aria-label={`${label}: ${data.map((d) => `${d.name} ${d.value}`).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 16, right: 24 }}>
          <CartesianGrid horizontal={false} stroke="var(--line)" />
          <XAxis type="number" allowDecimals={false} {...axisProps} />
          <YAxis type="category" dataKey="name" width={130} {...axisProps} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--surface-2)' }} formatter={(v) => [v, label]} />
          <Bar dataKey="value" fill="var(--series-1)" radius={[0, 4, 4, 0]} barSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-ink-2">{label}</p>
      {note && <p className="text-[11px] text-ink-3">{note}</p>}
    </div>
  );
}

export default function AnalyticsPage() {
  const { clientId, clients } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'content' | 'platforms' | 'leads' | 'ai' | 'reports'>('overview');
  const [days, setDays] = useState('30');
  const range = useMemo(() => ({ from: new Date(Date.now() - Number(days) * 86_400_000).toISOString(), to: new Date().toISOString() }), [days]);
  const query = { clientId, ...range };
  const overview = useQuery({ queryKey: ['analytics', 'overview', clientId, days], queryFn: () => api<Overview>('/analytics/overview', { query }) });
  const content = useQuery({ queryKey: ['analytics', 'content', clientId, days], queryFn: () => api<ContentPerf[]>('/analytics/content', { query }), enabled: tab === 'content' });
  const platforms = useQuery({ queryKey: ['analytics', 'platforms', clientId, days], queryFn: () => api<{ platform: PlatformKey; posts: number; conversations: number; leads: number }[]>('/analytics/platforms', { query }), enabled: tab === 'platforms' });
  const leads = useQuery({ queryKey: ['analytics', 'leads', clientId, days], queryFn: () => api<{ total: number; conversionRate: number | null; byStatus: { status: string; count: number }[]; bySource: { source: string; count: number }[] }>('/analytics/leads', { query }), enabled: tab === 'leads' });
  const ai = useQuery({ queryKey: ['analytics', 'ai', clientId, days], queryFn: () => api<{ byDecision: { decision: string; count: number }[]; byIntent: { intent: string; count: number }[]; averageConfidence: number | null; escalationsByReason: { reason: string; count: number }[]; note: string }>('/analytics/ai', { query }), enabled: tab === 'ai' });
  const reports = useQuery({ queryKey: ['reports', clientId], queryFn: () => api<Report[]>('/analytics/reports', { query: { clientId } }), enabled: tab === 'reports' });
  const [reportClient, setReportClient] = useState(clientId ?? clients[0]?.id ?? '');
  const generate = useMutation({
    mutationFn: () => api('/analytics/reports', { body: { clientId: reportClient, from: range.from, to: range.to } }),
    onSuccess: () => {
      toast.success('Report ready');
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sync = useMutation({ mutationFn: () => api<{ queued: number }>('/analytics/sync', { body: { clientId } }), onSuccess: (r) => toast.success(`Refreshing metrics for ${r.queued} accounts`), onError: (e) => toast.error(errorMessage(e)) });

  const o = overview.data;
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Built from stored platform metrics and your own activity. Metrics a platform doesn’t provide are shown as unavailable, never estimated."
        actions={
          <>
            <Select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)} className="w-40">
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </Select>
            <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()}><RefreshCw className="h-4 w-4" /> Refresh metrics</Button>
          </>
        }
      />
      <div className="mb-4">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'overview', label: 'Overview' }, { value: 'content', label: 'Content' }, { value: 'platforms', label: 'Platforms' }, { value: 'leads', label: 'Leads' }, { value: 'ai', label: 'AI' }, { value: 'reports', label: 'Reports' }]} />
      </div>

      {tab === 'overview' && (
        <>
          {overview.isLoading && <Skeleton className="h-48" />}
          {overview.error && <ErrorState error={overview.error} onRetry={() => overview.refetch()} />}
          {o && (
            <div className="space-y-6">
              {o.mockDataPresent && <p className="flex items-center gap-2 text-sm text-ink-2"><MockBadge /> Some metrics come from mock accounts and are simulated.</p>}
              <section>
                <h2 className="mb-2 text-sm font-semibold">Activity</h2>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line">
                  <Metric label="Posts published" value={o.posts.published} />
                  <Metric label="Failed posts" value={o.posts.failed} />
                  <Metric label="Messages received" value={o.messages.inbound} />
                  <Metric label="Replies sent" value={o.messages.outbound} />
                  <Metric label="Sent automatically" value={o.messages.aiAutoSent} />
                  <Metric label="Escalations" value={o.messages.escalations} />
                  <Metric label="Leads detected" value={o.leads.created} />
                  <Metric label="First response" value={o.messages.averageFirstResponseMinutes === null ? '—' : `${o.messages.averageFirstResponseMinutes} min`} note="average" />
                </div>
              </section>
              <section>
                <h2 className="mb-2 text-sm font-semibold">Platform metrics</h2>
                {Object.keys(o.platformMetrics).length ? (
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line">
                    {Object.entries(o.platformMetrics).map(([k, v]) => <Metric key={k} label={humanize(k)} value={Math.round(v).toLocaleString()} note={k === 'followers' ? 'latest' : 'total'} />)}
                  </div>
                ) : (
                  <Panel><EmptyState title="No platform metrics yet" description="Metrics are collected every few hours from accounts whose API provides them." /></Panel>
                )}
                {o.unavailableMetrics.length > 0 && <p className="mt-2 text-xs text-ink-3">Not provided by the connected platforms: {o.unavailableMetrics.map(humanize).join(', ')}.</p>}
              </section>
            </div>
          )}
        </>
      )}

      {tab === 'content' && (
        <Panel>
          {content.isLoading && <Skeleton className="m-4 h-40" />}
          {content.data?.length === 0 && <EmptyState title="No published posts in this period" />}
          {!!content.data?.length && (
            <Table>
              <thead><tr><Th>Post</Th><Th>Published</Th><Th className="text-right">Reach</Th><Th className="text-right">Likes</Th><Th className="text-right">Comments</Th><Th className="text-right">Shares</Th><Th className="text-right">Engagement</Th></tr></thead>
              <tbody>
                {[...content.data].sort((a, b) => (b.engagement ?? -1) - (a.engagement ?? -1)).map((p) => (
                  <tr key={p.publishedPostId}>
                    <Td><span className="flex items-center gap-2"><PlatformChip platform={p.platform} size="sm" /><span className="max-w-72 truncate font-medium">{p.title}</span>{p.isMock && <MockBadge />}</span></Td>
                    <Td className="text-ink-2">{day(p.publishedAt)}</Td>
                    {(['reach', 'likes', 'comments', 'shares'] as const).map((m) => <Td key={m} className="text-right tabular-nums">{p.metrics[m]?.toLocaleString() ?? <span className="text-ink-3" title="Not provided by the platform">n/a</span>}</Td>)}
                    <Td className="text-right font-medium tabular-nums">{p.engagement?.toLocaleString() ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}

      {tab === 'platforms' && (
        <Panel>
          <PanelHeader title="Activity by platform" description="Published posts, active conversations and new leads in the period." />
          {platforms.isLoading && <Skeleton className="m-4 h-64" />}
          {platforms.data?.length === 0 && <EmptyState title="No activity in this period" />}
          {!!platforms.data?.length && (
            <>
              <div className="h-72 px-2 py-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={platforms.data.map((p) => ({ ...p, name: platformName(p.platform) }))} margin={{ right: 16 }} barGap={2}>
                    <CartesianGrid vertical={false} stroke="var(--line)" />
                    <XAxis dataKey="name" {...axisProps} />
                    <YAxis allowDecimals={false} {...axisProps} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--surface-2)' }} />
                    <Legend wrapperStyle={{ fontSize: 12, color: 'var(--ink-2)' }} />
                    <Bar dataKey="posts" name="Posts" fill="var(--series-1)" radius={[4, 4, 0, 0]} barSize={14} />
                    <Bar dataKey="conversations" name="Conversations" fill="var(--series-2)" radius={[4, 4, 0, 0]} barSize={14} />
                    <Bar dataKey="leads" name="Leads" fill="var(--series-3)" radius={[4, 4, 0, 0]} barSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table>
                <thead><tr><Th>Platform</Th><Th className="text-right">Posts</Th><Th className="text-right">Conversations</Th><Th className="text-right">Leads</Th></tr></thead>
                <tbody>{platforms.data.map((p) => <tr key={p.platform}><Td><PlatformChip platform={p.platform} withName size="sm" /></Td><Td className="text-right tabular-nums">{p.posts}</Td><Td className="text-right tabular-nums">{p.conversations}</Td><Td className="text-right tabular-nums">{p.leads}</Td></tr>)}</tbody>
              </Table>
            </>
          )}
        </Panel>
      )}

      {tab === 'leads' && leads.data && (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Leads by stage" description={`${leads.data.total} leads${leads.data.conversionRate !== null ? `, ${leads.data.conversionRate}% won` : ''}`} />
            <SingleBar label="Leads" data={leads.data.byStatus.map((s) => ({ name: humanize(s.status), value: s.count }))} />
          </Panel>
          <Panel>
            <PanelHeader title="Leads by source" />
            <SingleBar label="Leads" data={leads.data.bySource.map((s) => ({ name: s.source.startsWith('ai:') ? `AI, ${humanize(s.source.slice(3))}` : s.source, value: s.count }))} />
          </Panel>
        </div>
      )}

      {tab === 'ai' && ai.data && (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">{ai.data.note} Average: {ai.data.averageConfidence === null ? '—' : `${Math.round(ai.data.averageConfidence * 100)}%`}.</p>
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
            <Panel>
              <PanelHeader title="What happened to AI drafts" />
              <SingleBar label="Drafts" data={ai.data.byDecision.map((d) => ({ name: humanize(d.decision), value: d.count }))} />
            </Panel>
            <Panel>
              <PanelHeader title="Escalation reasons" />
              <SingleBar label="Escalations" data={ai.data.escalationsByReason.map((d) => ({ name: humanize(d.reason).slice(0, 28), value: d.count }))} />
            </Panel>
          </div>
        </div>
      )}

      {tab === 'reports' && (
        <div className="space-y-4">
          <Panel className="flex flex-wrap items-center gap-3 p-4">
            <ClientSelect aria-label="Client" className="w-64" value={reportClient || null} onChange={(v) => v && setReportClient(v)} />
            <Button loading={generate.isPending} disabled={!reportClient} onClick={() => generate.mutate()}><Sparkles className="h-4 w-4" /> Write report for the last {days} days</Button>
            <p className="text-xs text-ink-3">The AI summarizes stored numbers only and notes correlations, not causes.</p>
          </Panel>
          {reports.data?.length === 0 && <Panel><EmptyState title="No reports yet" /></Panel>}
          {reports.data?.map((r) => (
            <Panel key={r.id}>
              <PanelHeader title={r.summary.headline} description={`${day(r.periodStart)} to ${day(r.periodEnd)}, written ${when(r.createdAt)}`} />
              <div className="grid grid-cols-1 gap-6 p-5 text-sm lg:grid-cols-2">
                <div className="space-y-3">
                  <p className="whitespace-pre-wrap leading-relaxed">{r.summary.summary}</p>
                  {r.summary.highlights.length > 0 && <ul className="list-disc space-y-1 pl-5">{r.summary.highlights.map((h) => <li key={h}>{h}</li>)}</ul>}
                </div>
                <div className="space-y-3">
                  {r.summary.contentIdeas.length > 0 && <div><p className="font-medium">Content ideas</p><ul className="mt-1 list-disc pl-5">{r.summary.contentIdeas.map((h) => <li key={h}>{h}</li>)}</ul></div>}
                  {r.summary.caveats.length > 0 && <div className="flex flex-wrap gap-1.5">{r.summary.caveats.map((c) => <Badge key={c} tone="runway">{c}</Badge>)}</div>}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
