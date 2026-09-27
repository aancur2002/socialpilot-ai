'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageCircle, Phone } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { LEAD_STAGES, LeadNotes, LeadStatusBadge } from '@/components/crm';
import { ConfidenceMeter, humanize, PlatformChip, when } from '@/components/domain';
import { Badge, Button, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Lead, Member } from '@/lib/types';

type LeadPatch = Partial<Omit<Lead, 'followUpAt'>> & { followUpAt?: string | null };

/** "2026-10-02T14:30" for <input type="datetime-local"> in the viewer's time zone. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const sourceLabel = (l: Lead) => (l.source.startsWith('ai:') ? 'Detected by AI in a conversation' : l.source === 'website_form' ? `Website form${l.form ? `: ${l.form.name}` : ''}` : l.source === 'api' ? 'Lead API' : humanize(l.source));
const digits = (p: string) => p.replace(/[^\d+]/g, '');

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lead', id], queryFn: () => api<Lead>(`/leads/${id}`) });
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ members: Member[] }>('/organizations/current/members'), enabled: can('users:view') });
  const update = useMutation({
    mutationFn: (body: LeadPatch) => api<Lead>(`/leads/${id}`, { method: 'PATCH', body }),
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
  const editable = can('leads:manage');
  const overdue = l.followUpAt && new Date(l.followUpAt) < new Date() && !['WON', 'LOST'].includes(l.status);

  return (
    <>
      <PageHeader
        title={l.name ?? l.username ?? l.email ?? 'Lead'}
        description={<span className="flex flex-wrap items-center gap-2"><LeadStatusBadge status={l.status} />{l.company && <span>{l.company},</span>}{l.client?.name}, created {when(l.createdAt)}</span>}
        actions={
          <div className="flex flex-wrap gap-2">
            {l.email && <a href={`mailto:${l.email}`}><Button variant="secondary"><Mail className="h-4 w-4" /> Email</Button></a>}
            {l.phone && <a href={`tel:${digits(l.phone)}`}><Button variant="secondary"><Phone className="h-4 w-4" /> Call</Button></a>}
            {l.phone && <a href={`https://wa.me/${digits(l.phone).replace(/^\+/, '')}`} target="_blank" rel="noreferrer"><Button variant="secondary"><MessageCircle className="h-4 w-4" /> WhatsApp</Button></a>}
          </div>
        }
      />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {(l.message || Object.keys(l.customFields ?? {}).length > 0) && (
            <Panel>
              <PanelHeader title="What they said" />
              <div className="space-y-3 p-5 text-sm">
                {l.message && <p className="whitespace-pre-line">{l.message}</p>}
                {Object.keys(l.customFields ?? {}).length > 0 && (
                  <dl className="grid grid-cols-[140px_1fr] gap-y-1.5">
                    {Object.entries(l.customFields).map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-3">{k}</dt><dd>{String(v)}</dd></div>)}
                  </dl>
                )}
              </div>
            </Panel>
          )}
          <Panel>
            <PanelHeader title="Notes and activity" />
            <div className="p-5">{editable ? <LeadNotes lead={l} /> : <p className="text-sm text-ink-2">You can view notes but not add them.</p>}</div>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Pipeline" />
            <div className="space-y-4 p-5 text-sm">
              <Field label="Stage" htmlFor="stage">
                <Select id="stage" value={l.status} disabled={!editable} onChange={(e) => update.mutate({ status: e.target.value as Lead['status'] })}>
                  {LEAD_STAGES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                </Select>
              </Field>
              {l.status === 'LOST' && <LostReason lead={l} disabled={!editable} onSave={(lostReason) => update.mutate({ lostReason })} />}
              {members.data && (
                <Field label="Owner" htmlFor="owner">
                  <Select id="owner" value={l.assignedToId ?? ''} disabled={!editable} onChange={(e) => update.mutate({ assignedToId: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {members.data.members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Follow up" htmlFor="follow" hint={overdue ? 'Overdue' : l.followUpAt ? 'The owner (or the team) gets a reminder at this time.' : 'Set a date to get a reminder.'}>
                <div className="flex gap-2">
                  <Input id="follow" type="datetime-local" disabled={!editable} defaultValue={toLocalInput(l.followUpAt)} key={l.followUpAt ?? 'none'} className={overdue ? 'border-alert' : undefined}
                    onBlur={(e) => { const v = e.target.value ? new Date(e.target.value).toISOString() : null; if (v !== l.followUpAt) update.mutate({ followUpAt: v }); }} />
                  {l.followUpAt && editable && <Button variant="ghost" onClick={() => update.mutate({ followUpAt: null })}>Clear</Button>}
                </div>
              </Field>
            </div>
          </Panel>
          <LeadDetails lead={l} editable={editable} saving={update.isPending} onSave={(body) => update.mutate(body)} />
          <Panel>
            <PanelHeader title="Where it came from" />
            <dl className="grid grid-cols-[110px_1fr] gap-y-2 p-5 text-sm">
              <dt className="text-ink-3">Source</dt><dd>{sourceLabel(l)}</dd>
              {l.pageUrl && <><dt className="text-ink-3">Page</dt><dd className="break-all"><a href={l.pageUrl} target="_blank" rel="noreferrer" className="text-clearance hover:underline">{l.pageUrl}</a></dd></>}
              {(l.utmSource || l.utmMedium || l.utmCampaign) && <><dt className="text-ink-3">Campaign</dt><dd>{[l.utmSource, l.utmMedium, l.utmCampaign].filter(Boolean).join(' / ')}</dd></>}
              {l.intent && <><dt className="text-ink-3">Intent</dt><dd>{humanize(l.intent)}</dd></>}
              {l.confidence !== null && <><dt className="text-ink-3">AI confidence</dt><dd><ConfidenceMeter value={l.confidence} /></dd></>}
              {l.platform && <><dt className="text-ink-3">Platform</dt><dd><PlatformChip platform={l.platform} withName size="sm" /></dd></>}
            </dl>
            {l.conversation && (
              <Link href={`/inbox/${l.conversation.id}`} className="mx-5 mb-5 block rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm hover:bg-surface-2">
                <p className="text-xs text-ink-3">Source conversation</p>
                <p className="line-clamp-2">{l.conversation.lastMessagePreview}</p>
              </Link>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function LostReason({ lead, disabled, onSave }: { lead: Lead; disabled: boolean; onSave: (v: string | null) => void }) {
  const [v, setV] = useState(lead.lostReason ?? '');
  return (
    <Field label="Why was it lost?" htmlFor="lost">
      <Input id="lost" disabled={disabled} placeholder="e.g. Too expensive, chose a competitor" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== (lead.lostReason ?? '') && onSave(v || null)} />
    </Field>
  );
}

function LeadDetails({ lead, editable, saving, onSave }: { lead: Lead; editable: boolean; saving: boolean; onSave: (b: LeadPatch) => void }) {
  const init = () => ({ name: lead.name ?? '', company: lead.company ?? '', email: lead.email ?? '', phone: lead.phone ?? '', value: lead.value?.toString() ?? '', interest: lead.interest ?? '', tags: lead.tags.join(', ') });
  const [f, setF] = useState(init);
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <Panel>
        <PanelHeader title="Contact details" actions={editable && <Button variant="ghost" size="sm" onClick={() => { setF(init()); setEditing(true); }}>Edit</Button>} />
        <dl className="grid grid-cols-[110px_1fr] gap-y-2 p-5 text-sm">
          <dt className="text-ink-3">Name</dt><dd>{lead.name ?? '—'}</dd>
          <dt className="text-ink-3">Company</dt><dd>{lead.company ?? '—'}</dd>
          <dt className="text-ink-3">Email</dt><dd className="break-all">{lead.email ?? '—'}</dd>
          <dt className="text-ink-3">Phone</dt><dd>{lead.phone ?? '—'}</dd>
          <dt className="text-ink-3">Deal value</dt><dd className="tabular-nums">{lead.value?.toLocaleString() ?? '—'}</dd>
          <dt className="text-ink-3">Interested in</dt><dd>{lead.interest ?? '—'}</dd>
          <dt className="text-ink-3">Tags</dt><dd className="flex flex-wrap gap-1">{lead.tags.length ? lead.tags.map((t) => <Badge key={t}>{t}</Badge>) : '—'}</dd>
        </dl>
      </Panel>
    );
  }
  return (
    <Panel>
      <PanelHeader title="Contact details" />
      <div className="space-y-3 p-5">
        {(['name', 'company', 'email', 'phone', 'interest'] as const).map((k) => (
          <Field key={k} label={k === 'interest' ? 'Interested in' : humanize(k)} htmlFor={`ld-${k}`}><Input id={`ld-${k}`} type={k === 'email' ? 'email' : 'text'} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
        ))}
        <Field label="Deal value" htmlFor="ld-value"><Input id="ld-value" inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
        <Field label="Tags" htmlFor="ld-tags" hint="Separate with commas."><Textarea id="ld-tags" rows={1} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
        <div className="flex gap-2">
          <Button loading={saving} onClick={() => {
            const value = f.value.trim() === '' ? null : Number(f.value);
            if (value !== null && (!Number.isFinite(value) || value < 0)) return toast.error('Deal value must be a positive number');
            onSave({ name: f.name || null, company: f.company || null, email: f.email || null, phone: f.phone || null, interest: f.interest || null, value, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) });
            setEditing(false);
          }}>Save</Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </div>
    </Panel>
  );
}
