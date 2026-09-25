'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ago, humanize, PlatformChip } from '@/components/domain';
import { Drawer } from '@/components/ui/overlay';
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Panel, Skeleton, Table, Td, Textarea, Th } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Paged, PlatformKey } from '@/lib/types';

interface ContactRow { id: string; platform: PlatformKey; name: string | null; username: string | null; email: string | null; phone: string | null; tags: string[]; updatedAt: string; client: { name: string }; _count: { conversations: number; leads: number } }
interface ContactDetail {
  id: string;
  platform: PlatformKey;
  name: string | null;
  username: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  tags: string[];
  conversations: { id: string; platform: PlatformKey; lastMessagePreview: string | null; lastMessageAt: string; status: string }[];
  leads: { id: string; status: string; interest: string | null }[];
}

function ContactDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const editable = can('leads:manage');
  const q = useQuery({ queryKey: ['contact', id], queryFn: () => api<ContactDetail>(`/contacts/${id}`), enabled: Boolean(id) });
  const [f, setF] = useState({ name: '', email: '', phone: '', notes: '', tags: '' });
  useEffect(() => {
    if (q.data) setF({ name: q.data.name ?? '', email: q.data.email ?? '', phone: q.data.phone ?? '', notes: q.data.notes ?? '', tags: q.data.tags.join(', ') });
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api(`/contacts/${id}`, { method: 'PATCH', body: { name: f.name || null, email: f.email || null, phone: f.phone || null, notes: f.notes || null, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) } }),
    onSuccess: () => {
      toast.success('Contact saved');
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['contact', id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const c = q.data;
  return (
    <Drawer open={Boolean(id)} onOpenChange={(o) => !o && onClose()} title={c?.name ?? c?.username ?? 'Contact'} footer={editable && c ? <Button loading={save.isPending} onClick={() => save.mutate()}>Save contact</Button> : undefined}>
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {c && (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm text-ink-2"><PlatformChip platform={c.platform} withName size="sm" />{c.username && <span>@{c.username}</span>}</p>
          <Field label="Name" htmlFor="ct-name"><Input id="ct-name" value={f.name} disabled={!editable} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email" htmlFor="ct-email"><Input id="ct-email" type="email" value={f.email} disabled={!editable} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Phone" htmlFor="ct-phone"><Input id="ct-phone" value={f.phone} disabled={!editable} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Tags" htmlFor="ct-tags" hint="Separate with commas"><Input id="ct-tags" value={f.tags} disabled={!editable} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
          <Field label="Notes" htmlFor="ct-notes"><Textarea id="ct-notes" value={f.notes} disabled={!editable} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          {c.conversations.length > 0 && (
            <div>
              <p className="mb-1.5 text-sm font-medium">Conversations</p>
              <ul className="space-y-1.5">
                {c.conversations.map((cv) => (
                  <li key={cv.id}>
                    <Link href={`/inbox/${cv.id}`} className="block rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm hover:bg-surface-2">
                      <span className="line-clamp-1">{cv.lastMessagePreview ?? 'Conversation'}</span>
                      <span className="text-xs text-ink-3">{humanize(cv.status)}, {ago(cv.lastMessageAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.leads.length > 0 && (
            <div>
              <p className="mb-1.5 text-sm font-medium">Leads</p>
              {c.leads.map((l) => <Link key={l.id} href={`/leads/${l.id}`} className="mr-2 inline-block"><Badge tone="clearance">{humanize(l.status)}{l.interest ? `: ${l.interest.slice(0, 30)}` : ''}</Badge></Link>)}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

export default function ContactsPage() {
  const { clientId } = useSession();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['contacts', clientId, search], queryFn: () => api<Paged<ContactRow>>('/contacts', { query: { clientId, search, limit: 200 } }) });
  return (
    <>
      <PageHeader title="Contacts" description="Everyone who has messaged or commented on a connected account. Click a contact to edit it." />
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
                <tr key={c.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setOpen(c.id)}>
                  <Td><span className="flex items-center gap-2 font-medium"><PlatformChip platform={c.platform} size="sm" /><button className="hover:underline" onClick={() => setOpen(c.id)}>{c.name ?? c.username ?? 'Unknown'}</button></span><span className="text-xs text-ink-3">{c.client.name}</span></Td>
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
      <ContactDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}
