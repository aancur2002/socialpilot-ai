'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ago, PlatformChip, when, humanize } from '@/components/domain';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Panel, Select, Skeleton } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { PlatformKey } from '@/lib/types';

interface ApprovalItem {
  id: string;
  clientId: string;
  status: string;
  comment: string | null;
  createdAt: string;
  content: { id: string; title: string; status: string; scheduledAt: string | null; aiGenerated: boolean; variants: { platform: PlatformKey }[] };
}

export default function ApprovalsPage() {
  const { clientId, can, clients } = useSession();
  const qc = useQueryClient();
  const [status, setStatus] = useState('PENDING');
  const q = useQuery({ queryKey: ['approvals', clientId, status], queryFn: () => api<ApprovalItem[]>('/approvals', { query: { clientId, status } }) });
  const approve = useMutation({
    mutationFn: (contentId: string) => api(`/content/${contentId}/approve`, { body: { decision: 'APPROVE' } }),
    onSuccess: () => {
      toast.success('Approved');
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name;

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Posts waiting for a decision before they can be scheduled."
        actions={
          <Select aria-label="Filter" value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
            {['PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </Select>
        }
      />
      <Panel>
        {q.isLoading && <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data?.length === 0 && <EmptyState icon={<CheckCircle2 className="h-8 w-8" />} title={status === 'PENDING' ? 'No posts waiting for approval' : 'Nothing here'} description="Posts submitted for review appear here." />}
        <ul className="space-y-1.5 p-3">
          {q.data?.map((a) => (
            <li key={a.id} className={`strip ${a.status === 'PENDING' ? 'strip-runway' : a.status === 'APPROVED' ? 'strip-clearance' : 'strip-alert'} flex flex-wrap items-center gap-3 rounded-r-md bg-surface-2/50 px-4 py-3`}>
              <div className="min-w-0 flex-1">
                <Link href={`/content/${a.content.id}`} className="font-medium hover:underline">{a.content.title}</Link>
                <p className="text-xs text-ink-3">
                  {clientName(a.clientId)}, submitted {ago(a.createdAt)}
                  {a.content.scheduledAt ? `, planned for ${when(a.content.scheduledAt)}` : ''}
                </p>
                {a.comment && <p className="mt-1 text-sm text-ink-2">“{a.comment}”</p>}
              </div>
              <div className="flex gap-1">{a.content.variants.map((v, i) => <PlatformChip key={i} platform={v.platform} size="sm" />)}</div>
              {a.content.aiGenerated && <Badge tone="sky">AI draft</Badge>}
              {a.status === 'PENDING' && can('content:approve') && (
                <div className="flex gap-2">
                  <Link href={`/content/${a.content.id}`}><Button size="sm" variant="secondary">Review</Button></Link>
                  <Button size="sm" loading={approve.isPending && approve.variables === a.content.id} onClick={() => approve.mutate(a.content.id)}>Approve</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
