'use client';

import { ClientSelect } from './client-select';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Lead, LeadStatus, Paged, PlatformKey } from '@/lib/types';
import { ago, humanize, PlatformChip, when } from './domain';
import { Modal } from './ui/overlay';
import { Badge, Button, cn, EmptyState, ErrorState, Field, Input, Select, Skeleton, Table, Td, Th, Textarea } from './ui/primitives';

export const LEAD_STAGES: LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'APPOINTMENT', 'PROPOSAL', 'WON', 'LOST'];
const stageTone = (s: LeadStatus) => (s === 'WON' ? 'clearance' : s === 'LOST' ? 'alert' : s === 'NEW' ? 'runway' : 'sky') as 'clearance' | 'alert' | 'runway' | 'sky';
export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return <Badge tone={stageTone(status)}>{humanize(status)}</Badge>;
}

export function NewLeadButton() {
  const { clients, clientId, can } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ clientId: clientId ?? clients[0]?.id ?? '', name: '', email: '', phone: '', interest: '', value: '', source: 'manual' });
  const create = useMutation({
    mutationFn: () => api('/leads', { body: { ...form, value: form.value ? Number(form.value) : null, status: 'NEW' } }),
    onSuccess: () => {
      toast.success('Lead added');
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['pipeline'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!can('leads:manage')) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add lead
      </Button>
      <Modal open={open} onOpenChange={setOpen} title="Add a lead" footer={<Button loading={create.isPending} disabled={!form.clientId} onClick={() => create.mutate()}>Add lead</Button>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Client" htmlFor="l-client">
            <ClientSelect id="l-client" value={form.clientId || null} onChange={(v) => v && setForm({ ...form, clientId: v })} />
          </Field>
          <Field label="Name" htmlFor="l-name"><Input id="l-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email" htmlFor="l-email"><Input id="l-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone" htmlFor="l-phone"><Input id="l-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Interested in" htmlFor="l-int"><Input id="l-int" value={form.interest} onChange={(e) => setForm({ ...form, interest: e.target.value })} /></Field>
          <Field label="Estimated value" htmlFor="l-val"><Input id="l-val" type="number" min="0" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></Field>
          <Field label="Source" htmlFor="l-src"><Input id="l-src" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

/** Short, readable name for where a lead came from. */
export function sourceName(source: string) {
  if (source.startsWith('ai:')) return 'AI (conversation)';
  if (source === 'website_form') return 'Website form';
  if (source === 'api') return 'Lead API';
  return humanize(source);
}

export function LeadsTable() {
  const { clientId } = useSession();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['leads', clientId, status, search], queryFn: () => api<Paged<Lead>>('/leads', { query: { clientId, status, search, limit: 200 } }) });
  return (
    <>
      <div className="flex flex-wrap gap-2 border-b border-line p-3">
        <Input className="max-w-xs" aria-label="Search leads" placeholder="Search name, email, company, tag" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select className="max-w-44" aria-label="Stage" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All stages</option>
          {LEAD_STAGES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </Select>
      </div>
      {q.isLoading && <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data?.items.length === 0 && <EmptyState icon={<Users className="h-8 w-8" />} title="No leads yet" description="Leads are created automatically when customers show buying intent in messages, or you can add them yourself." />}
      {!!q.data?.items.length && (
        <Table>
          <thead>
            <tr><Th>Lead</Th><Th>Interested in</Th><Th>Source</Th><Th>Stage</Th><Th className="text-right">Value</Th><Th>Follow up</Th><Th>Created</Th></tr>
          </thead>
          <tbody>
            {q.data.items.map((l) => (
              <tr key={l.id} className="hover:bg-surface-2">
                <Td>
                  <Link href={`/leads/${l.id}`} className="flex items-center gap-2 font-medium hover:underline">
                    {l.platform && <PlatformChip platform={l.platform} size="sm" />}
                    {l.name ?? l.contact?.name ?? l.username ?? 'Unnamed lead'}
                  </Link>
                  <span className="text-xs text-ink-3">{[l.email, l.phone].filter(Boolean).join(', ') || l.client?.name}</span>
                </Td>
                <Td className="max-w-64 truncate text-ink-2">{l.interest ?? l.company ?? '—'}</Td>
                <Td className="text-ink-2">{sourceName(l.source)}</Td>
                <Td><LeadStatusBadge status={l.status} /></Td>
                <Td className="text-right tabular-nums">{l.value ? l.value.toLocaleString() : '—'}</Td>
                <Td className={l.followUpAt && new Date(l.followUpAt) < new Date() && !['WON', 'LOST'].includes(l.status) ? 'font-medium text-alert' : 'text-ink-2'}>{l.followUpAt ? when(l.followUpAt) : '—'}</Td>
                <Td className="text-ink-2">{ago(l.createdAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

interface PipelineLead { id: string; name: string | null; username: string | null; platform: PlatformKey | null; interest: string | null; status: LeadStatus; value: number | null; createdAt: string }

function LeadCard({ lead }: { lead: PipelineLead }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: lead.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} style={{ transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined }} className={cn('cursor-grab rounded-[var(--radius-control)] border border-line bg-surface p-3 text-sm shadow-sm', isDragging && 'z-10 opacity-80')}>
      <Link href={`/leads/${lead.id}`} className="font-medium hover:underline" onPointerDown={(e) => e.stopPropagation()}>{lead.name ?? lead.username ?? 'Unnamed lead'}</Link>
      {lead.interest && <p className="mt-1 line-clamp-2 text-xs text-ink-2">{lead.interest}</p>}
      <div className="mt-2 flex items-center justify-between text-xs text-ink-3">
        {lead.platform ? <PlatformChip platform={lead.platform} size="sm" /> : <span />}
        {lead.value ? <span className="tabular-nums">{lead.value.toLocaleString()}</span> : <span>{ago(lead.createdAt)}</span>}
      </div>
    </div>
  );
}

function Stage({ status, leads }: { status: LeadStatus; leads: PipelineLead[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const total = leads.reduce((s, l) => s + (l.value ?? 0), 0);
  return (
    <div ref={setNodeRef} className={cn('flex w-64 shrink-0 flex-col rounded-[var(--radius-panel)] border border-line bg-surface-2/50', isOver && 'border-sky bg-sky-soft')}>
      <div className="flex items-center justify-between px-3 py-2.5">
        <LeadStatusBadge status={status} />
        <span className="text-xs text-ink-3">{leads.length}{total ? `, ${total.toLocaleString()}` : ''}</span>
      </div>
      <div className="flex min-h-40 flex-col gap-2 px-2 pb-2">{leads.map((l) => <LeadCard key={l.id} lead={l} />)}</div>
    </div>
  );
}

export function Pipeline() {
  const { clientId, can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pipeline', clientId], queryFn: () => api<{ leads: PipelineLead[] }>('/leads/pipeline', { query: { clientId } }) });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: LeadStatus }) => api(`/leads/${id}`, { method: 'PATCH', body: { status } }),
    onMutate: ({ id, status }) => {
      qc.setQueryData(['pipeline', clientId], (d: { leads: PipelineLead[] } | undefined) => d && { ...d, leads: d.leads.map((l) => (l.id === id ? { ...l, status } : l)) });
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['pipeline'] }),
  });
  if (q.isLoading) return <Skeleton className="h-80" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <DndContext sensors={sensors} onDragEnd={(e) => e.over && can('leads:manage') && move.mutate({ id: String(e.active.id), status: e.over.id as LeadStatus })}>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {LEAD_STAGES.filter((s) => s !== 'LOST').map((s) => <Stage key={s} status={s} leads={q.data!.leads.filter((l) => l.status === s)} />)}
      </div>
    </DndContext>
  );
}

export function LeadNotes({ lead }: { lead: Lead }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: () => api(`/leads/${lead.id}/notes`, { body: { body } }),
    onSuccess: () => {
      setBody('');
      qc.invalidateQueries({ queryKey: ['lead', lead.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="space-y-3">
      <Textarea aria-label="Add a note" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note for the team" />
      <Button size="sm" disabled={!body.trim()} loading={add.isPending} onClick={() => add.mutate()}>Add note</Button>
      <ul className="space-y-2">
        {lead.notes?.map((n) => (
          <li key={n.id} className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm">
            <p className="whitespace-pre-wrap">{n.body}</p>
            <p className="mt-1 text-xs text-ink-3">{ago(n.createdAt)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
