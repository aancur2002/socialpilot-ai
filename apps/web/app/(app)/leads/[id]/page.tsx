'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { LEAD_STAGES, LeadNotes, LeadStatusBadge } from '@/components/crm';
import { ConfidenceMeter, humanize, PlatformChip, when } from '@/components/domain';
import { ErrorState, Field, PageHeader, Panel, PanelHeader, Select, Skeleton } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Lead, Member } from '@/lib/types';

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lead', id], queryFn: () => api<Lead>(`/leads/${id}`) });
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ members: Member[] }>('/organizations/current/members'), enabled: can('users:view') });
  const update = useMutation({
    mutationFn: (body: Partial<Lead>) => api<Lead>(`/leads/${id}`, { method: 'PATCH', body }),
    onSuccess: (l) => {
      qc.setQueryData(['lead', id], l);
      qc.invalidateQueries({ queryKey: ['leads'] });
      toast.success('Lead updated');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const l = q.data!;
  return (
    <>
      <PageHeader title={l.name ?? l.username ?? 'Lead'} description={<span className="flex items-center gap-2"><LeadStatusBadge status={l.status} />{l.client?.name}, created {when(l.createdAt)}</span>} />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_360px]">
        <Panel>
          <PanelHeader title="Notes" />
          <div className="p-5">{can('leads:manage') ? <LeadNotes lead={l} /> : <p className="text-sm text-ink-2">You can view notes but not add them.</p>}</div>
        </Panel>
        <Panel>
          <PanelHeader title="Details" />
          <div className="space-y-4 p-5 text-sm">
            <Field label="Stage" htmlFor="stage">
              <Select id="stage" value={l.status} disabled={!can('leads:manage')} onChange={(e) => update.mutate({ status: e.target.value as Lead['status'] })}>
                {LEAD_STAGES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </Select>
            </Field>
            {members.data && (
              <Field label="Owner" htmlFor="owner">
                <Select id="owner" value={l.assignedToId ?? ''} disabled={!can('leads:manage')} onChange={(e) => update.mutate({ assignedToId: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {members.data.members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
                </Select>
              </Field>
            )}
            <dl className="grid grid-cols-[110px_1fr] gap-y-2">
              <dt className="text-ink-3">Interested in</dt><dd>{l.interest ?? '—'}</dd>
              <dt className="text-ink-3">Email</dt><dd>{l.email ?? '—'}</dd>
              <dt className="text-ink-3">Phone</dt><dd>{l.phone ?? '—'}</dd>
              <dt className="text-ink-3">Value</dt><dd className="tabular-nums">{l.value?.toLocaleString() ?? '—'}</dd>
              <dt className="text-ink-3">Source</dt><dd>{l.source.startsWith('ai:') ? 'Detected by AI' : l.source}</dd>
              {l.intent && <><dt className="text-ink-3">Intent</dt><dd>{humanize(l.intent)}</dd></>}
              {l.confidence !== null && <><dt className="text-ink-3">AI confidence</dt><dd><ConfidenceMeter value={l.confidence} /></dd></>}
              {l.platform && <><dt className="text-ink-3">Platform</dt><dd><PlatformChip platform={l.platform} withName size="sm" /></dd></>}
            </dl>
            {l.conversation && (
              <Link href={`/inbox/${l.conversation.id}`} className="block rounded-[var(--radius-control)] border border-line px-3 py-2 hover:bg-surface-2">
                <p className="text-xs text-ink-3">Source conversation</p>
                <p className="line-clamp-2">{l.conversation.lastMessagePreview}</p>
              </Link>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
