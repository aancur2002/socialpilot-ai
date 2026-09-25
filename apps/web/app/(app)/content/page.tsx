'use client';

import { useQuery } from '@tanstack/react-query';
import { FileText, Plus } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ContentStatusBadge, contentStrip, PlatformChip, ago, when } from '@/components/domain';
import { Badge, Button, EmptyState, ErrorState, Input, PageHeader, Panel, Select, Skeleton } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ContentListItem, Paged } from '@/lib/types';

function ContentList() {
  const { clientId, can } = useSession();
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['content', clientId, status, search], queryFn: () => api<Paged<ContentListItem>>('/content', { query: { clientId, status, search, limit: 100 } }) });

  return (
    <>
      <PageHeader
        title="Content"
        description="Every post and its platform versions, from draft to published."
        actions={
          can('content:create') && (
            <Link href="/content/new">
              <Button>
                <Plus className="h-4 w-4" /> New post
              </Button>
            </Link>
          )
        }
      />
      <Panel>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Input className="max-w-xs" aria-label="Search content" placeholder="Search titles and text" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select className="max-w-52" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'CANCELLED'].map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ')}
              </option>
            ))}
          </Select>
        </div>
        {q.isLoading && <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data?.items.length === 0 && (
          <EmptyState icon={<FileText className="h-8 w-8" />} title="No content yet" description="Generate a post with AI or write one yourself." action={can('content:create') ? <Link href="/content/new"><Button>New post</Button></Link> : undefined} />
        )}
        <ul className="space-y-1.5 p-3">
          {q.data?.items.map((c) => (
            <li key={c.id}>
              <Link href={`/content/${c.id}`} className={`strip ${contentStrip(c.status)} flex flex-wrap items-center gap-3 rounded-r-md bg-surface-2/50 px-4 py-3 hover:bg-surface-2`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{c.title}</p>
                  <p className="text-xs text-ink-3">
                    {c.client.name}, updated {ago(c.updatedAt)}
                    {c.scheduledAt ? `, planned for ${when(c.scheduledAt)}` : ''}
                  </p>
                </div>
                <div className="flex gap-1">{c.variants.map((v) => <PlatformChip key={v.id} platform={v.platform} size="sm" />)}</div>
                {c.aiGenerated && <Badge tone="sky">AI draft</Badge>}
                <ContentStatusBadge status={c.status} />
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

export default function ContentPage() {
  return (
    <Suspense>
      <ContentList />
    </Suspense>
  );
}
