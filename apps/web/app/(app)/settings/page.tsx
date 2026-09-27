'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_KEYS } from '@socialpilot/validation';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ago, humanize, when } from '@/components/domain';
import { BillingPanel } from '@/components/billing';
import { ClientMultiSelect } from '@/components/client-select';
import { AccountSettings } from '@/components/settings-account';
import { AiModelSettings } from '@/components/settings-ai';
import { ConfirmButton, Modal } from '@/components/ui/overlay';
import { Badge, Button, EmptyState, Field, Input, PageHeader, Panel, PanelHeader, Select, Skeleton, Table, Tabs, Td, Th } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Member, Paged } from '@/lib/types';

const ROLE_HELP: Record<string, string> = {
  ORG_OWNER: 'Everything, including billing',
  ORG_ADMIN: 'Everything except billing',
  MANAGER: 'Content, inbox, clients and automation',
  CONTENT_MANAGER: 'Create, edit and schedule content',
  SOCIAL_MEDIA_MANAGER: 'Content and the inbox',
  APPROVER: 'Review and approve content',
  CLIENT: 'See and approve their own content',
  VIEWER: 'Read-only',
};
const ASSIGNABLE = ROLE_KEYS.filter((r) => r !== 'SUPER_ADMIN');

interface AuditRow { id: string; action: string; resourceType: string; createdAt: string; ip: string | null; user: { name: string; email: string } | null }

function ClientAccessEditor({ member, onClose }: { member: Member; onClose: () => void }) {
  const qc = useQueryClient();
  const [access, setAccess] = useState<'ALL' | 'ASSIGNED'>(member.clientAccess);
  const [ids, setIds] = useState<string[]>(member.clientIds);
  const save = useMutation({
    mutationFn: () => api(`/organizations/current/members/${member.id}`, { method: 'PATCH', body: { clientAccess: access, clientIds: access === 'ASSIGNED' ? ids : [] } }),
    onSuccess: () => {
      toast.success('Client access updated');
      qc.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Client access for ${member.user.name}`} footer={<Button loading={save.isPending} disabled={access === 'ASSIGNED' && ids.length === 0} onClick={() => save.mutate()}>Save access</Button>}>
      <div className="space-y-4 text-sm">
        <label className="flex items-start gap-2"><input type="radio" checked={access === 'ALL'} onChange={() => setAccess('ALL')} /> <span><span className="font-medium">All clients</span><span className="block text-ink-2">Including clients added later.</span></span></label>
        <label className="flex items-start gap-2"><input type="radio" checked={access === 'ASSIGNED'} onChange={() => setAccess('ASSIGNED')} /> <span><span className="font-medium">Only selected clients</span></span></label>
        {access === 'ASSIGNED' && (
          <div className="pl-6">
            <ClientMultiSelect value={ids} onChange={setIds} />
          </div>
        )}
      </div>
    </Modal>
  );
}

function Members() {
  const { can, clients, me } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [invite, setInvite] = useState({ email: '', role: 'CONTENT_MANAGER', clientIds: [] as string[] });
  const [link, setLink] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['members'], queryFn: () => api<{ members: Member[]; invitations: { id: string; email: string; role: string; expiresAt: string }[] }>('/organizations/current/members') });
  const send = useMutation({
    mutationFn: () => api<{ acceptUrl: string }>('/organizations/current/invitations', { body: { ...invite, clientIds: invite.clientIds.length ? invite.clientIds : undefined } }),
    onSuccess: (r) => {
      setLink(r.acceptUrl);
      qc.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: object }) => api(`/organizations/current/members/${id}`, { method: 'PATCH', body }), onSuccess: () => { toast.success('Access updated'); qc.invalidateQueries({ queryKey: ['members'] }); }, onError: (e) => toast.error(errorMessage(e)) });

  if (q.isLoading) return <Skeleton className="h-48" />;
  return (
    <Panel>
      <PanelHeader title="Team" description="Roles decide what someone can do; client access decides which clients they see." actions={can('users:manage') && <Button onClick={() => { setOpen(true); setLink(null); }}><Plus className="h-4 w-4" /> Invite</Button>} />
      <Table>
        <thead><tr><Th>Member</Th><Th>Role</Th><Th>Clients</Th><Th>Last sign-in</Th><Th /></tr></thead>
        <tbody>
          {q.data?.members.map((m) => (
            <tr key={m.id}>
              <Td><p className="font-medium">{m.user.name}</p><p className="text-xs text-ink-3">{m.user.email}</p></Td>
              <Td>
                {can('users:manage') && m.user.id !== me.user.id ? (
                  <Select aria-label={`Role for ${m.user.name}`} value={m.role} onChange={(e) => update.mutate({ id: m.id, body: { role: e.target.value } })}>
                    {ASSIGNABLE.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
                  </Select>
                ) : (
                  <Badge>{humanize(m.role)}</Badge>
                )}
              </Td>
              <Td className="text-sm text-ink-2">
                {m.role === 'ORG_OWNER' || m.role === 'ORG_ADMIN' || m.clientAccess === 'ALL' ? 'All clients' : m.clientIds.map((id) => clients.find((c) => c.id === id)?.name ?? 'Hidden client').join(', ') || 'None'}
                {can('users:manage') && m.role !== 'ORG_OWNER' && m.role !== 'ORG_ADMIN' && m.user.id !== me.user.id && (
                  <button className="ml-2 text-xs font-medium text-clearance hover:underline" onClick={() => setEditing(m)}>Change</button>
                )}
              </Td>
              <Td className="text-ink-2">{m.user.lastLoginAt ? ago(m.user.lastLoginAt) : 'Never'}</Td>
              <Td className="text-right">
                {can('users:manage') && m.user.id !== me.user.id && (
                  <ConfirmButton title={`Remove ${m.user.name}?`} description="They lose access to this organization immediately." confirmLabel="Remove member" onConfirm={async () => { await api(`/organizations/current/members/${m.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['members'] }); }}>
                    Remove
                  </ConfirmButton>
                )}
              </Td>
            </tr>
          ))}
          {q.data?.invitations.map((i) => (
            <tr key={i.id} className="text-ink-2">
              <Td>{i.email}</Td>
              <Td><Badge tone="runway">Invited as {humanize(i.role)}</Badge></Td>
              <Td />
              <Td>Expires {when(i.expiresAt)}</Td>
              <Td />
            </tr>
          ))}
        </tbody>
      </Table>
      {editing && <ClientAccessEditor member={editing} onClose={() => setEditing(null)} />}
      <Modal open={open} onOpenChange={setOpen} title="Invite a teammate" footer={link ? <Button onClick={() => setOpen(false)}>Done</Button> : <Button loading={send.isPending} disabled={!invite.email} onClick={() => send.mutate()}>Create invitation</Button>}>
        {link ? (
          <div className="space-y-2 text-sm">
            <p>Share this link with {invite.email}. It works once and expires in 7 days.</p>
            <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
            <p className="text-xs text-ink-3">Email delivery depends on the server’s EMAIL_DRIVER setting.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Email" htmlFor="i-email"><Input id="i-email" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
            <Field label="Role" htmlFor="i-role" hint={ROLE_HELP[invite.role]}>
              <Select id="i-role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
                {ASSIGNABLE.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
              </Select>
            </Field>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Limit to clients</legend>
              <p className="mb-2 text-xs text-ink-3">Leave empty to use the role default (external roles see no clients until assigned).</p>
              <ClientMultiSelect value={invite.clientIds} onChange={(clientIds) => setInvite({ ...invite, clientIds })} placeholder="All clients the role allows" />
            </fieldset>
          </div>
        )}
      </Modal>
    </Panel>
  );
}

function AuditLog() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api<Paged<AuditRow>>('/audit-logs', { query: { limit: 100 } }) });
  if (q.isLoading) return <Skeleton className="h-48" />;
  return (
    <Panel>
      <PanelHeader title="Audit log" description="Who did what, and when. Kept for every change to content, access, accounts and automation." />
      {q.data?.items.length === 0 && <EmptyState title="No activity yet" />}
      <Table>
        <thead><tr><Th>When</Th><Th>Who</Th><Th>Action</Th><Th>Resource</Th><Th>IP</Th></tr></thead>
        <tbody>
          {q.data?.items.map((a) => (
            <tr key={a.id}>
              <Td className="whitespace-nowrap text-ink-2">{when(a.createdAt)}</Td>
              <Td>{a.user?.name ?? <span className="text-ink-3">System</span>}</Td>
              <Td>{humanize(a.action.replace('.', ' '))}</Td>
              <Td className="text-ink-2">{a.resourceType}</Td>
              <Td className="text-ink-3">{a.ip ?? '—'}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

export default function SettingsPage() {
  const { org, can } = useSession();
  const qc = useQueryClient();
  type Tab = 'general' | 'account' | 'ai' | 'team' | 'billing' | 'audit';
  const [tab, setTab] = useState<Tab>('general');
  useEffect(() => {
    // Deep links such as /settings?tab=billing from the payment reminder.
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted && ['general', 'account', 'ai', 'team', 'billing', 'audit'].includes(wanted)) setTab(wanted as Tab);
  }, []);
  const [name, setName] = useState(org.name);
  const save = useMutation({ mutationFn: () => api('/organizations/current', { method: 'PATCH', body: { name } }), onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['org'] }); }, onError: (e) => toast.error(errorMessage(e)) });
  const usageRows: [string, string][] = [['clients', 'Clients'], ['socialAccounts', 'Social accounts'], ['members', 'Team members'], ['aiGenerations', 'AI generations this month'], ['posts', 'Posts this month'], ['messages', 'Messages this month']];
  return (
    <>
      <PageHeader title="Settings" description={`${org.name}, ${humanize(org.plan)} plan. Your role: ${humanize(org.role)}.`} />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} items={[{ value: 'general', label: 'General' }, { value: 'account', label: 'Your account' }, ...(can('settings:manage') ? [{ value: 'ai' as const, label: 'AI models' }] : []), ...(can('users:view') ? [{ value: 'team' as const, label: 'Team' }] : []), ...(can('settings:manage') ? [{ value: 'billing' as const, label: 'Billing' }] : []), ...(can('audit:view') ? [{ value: 'audit' as const, label: 'Audit log' }] : [])]} /></div>
      {tab === 'general' && (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Organization" actions={can('settings:manage') && <Button loading={save.isPending} disabled={name === org.name || !name.trim()} onClick={() => save.mutate()}>Save</Button>} />
            <div className="p-5"><Field label="Name" htmlFor="o-name"><Input id="o-name" value={name} disabled={!can('settings:manage')} onChange={(e) => setName(e.target.value)} /></Field></div>
          </Panel>
          <Panel>
            <PanelHeader title="Plan usage" description="Payments aren’t connected yet; limits are enforced per plan." />
            <ul className="divide-y divide-line">
              {usageRows.map(([key, label]) => {
                const used = Number(org.usage[key] ?? 0);
                const limit = org.limits[key] ?? 0;
                const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
                return (
                  <li key={key} className="px-5 py-3 text-sm">
                    <div className="flex justify-between"><span>{label}</span><span className="tabular-nums text-ink-2">{used.toLocaleString()} of {limit >= 100000 ? 'unlimited' : limit.toLocaleString()}</span></div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className={`h-full ${pct > 90 ? 'bg-alert' : pct > 70 ? 'bg-runway' : 'bg-clearance'}`} style={{ width: `${pct}%` }} /></div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
      )}
      {tab === 'account' && <AccountSettings />}
      {tab === 'ai' && <AiModelSettings />}
      {tab === 'team' && <Members />}
      {tab === 'billing' && <BillingPanel />}
      {tab === 'audit' && <AuditLog />}
    </>
  );
}
