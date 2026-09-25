'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ago, PlatformChip } from '@/components/domain';
import { Badge, EmptyState, ErrorState, Input, PageHeader, Panel, Skeleton, Table, Td, Th } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Paged, PlatformKey } from '@/lib/types';

interface ContactRow { id: string; platform: PlatformKey; name: string | null; username: string | null; email: string | null; phone: string | null; tags: string[]; updatedAt: string; client: { name: string }; _count: { conversations: number; leads: number } }

export default function ContactsPage() {
  const { clientId } = useSession();
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['contacts', clientId, search], queryFn: () => api<Paged<ContactRow>>('/contacts', { query: { clientId, search, limit: 200 } }) });
  return (
    <>
      <PageHeader title="Contacts" description="Everyone who has messaged or commented on a connected account." />
      <Panel>
        <div className="border-b border-line p-3"><Input className="max-w-xs" aria-label="Search contacts" placeholder="Search name, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        {q.isLoading && <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data?.items.length === 0 && <EmptyState title="No contacts yet" description="Contacts are created when people message or comment." />}
        {!!q.data?.items.length && (
          <Table>
            <thead><tr><Th>Contact</Th><Th>Reach them at</Th><Th>Conversations</Th><Th>Leads</Th><Th>Tags</Th><Th>Last activity</Th></tr></thead>
            <tbody>
              {q.data.items.map((c) => (
                <tr key={c.id}>
                  <Td><span className="flex items-center gap-2 font-medium"><PlatformChip platform={c.platform} size="sm" />{c.name ?? c.username ?? 'Unknown'}</span><span className="text-xs text-ink-3">{c.client.name}</span></Td>
                  <Td className="text-ink-2">{[c.email, c.phone].filter(Boolean).join(', ') || '—'}</Td>
                  <Td className="tabular-nums">{c._count.conversations}</Td>
                  <Td className="tabular-nums">{c._count.leads}</Td>
                  <Td><span className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span></Td>
                  <Td className="text-ink-2">{ago(c.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
