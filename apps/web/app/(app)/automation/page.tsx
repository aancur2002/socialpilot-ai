'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INTENTS, PLATFORMS } from '@socialpilot/validation';
import { Plus, Trash2, Workflow, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { humanize, PlatformChip } from '@/components/domain';
import { ConfirmButton, Modal } from '@/components/ui/overlay';
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Panel, Select, Skeleton, Switch } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { AutomationRule, PlatformKey } from '@/lib/types';

type Condition = { field: string; op: string; value: unknown };
type Action = { type: string; [k: string]: unknown };

const TRIGGERS = [
  { value: 'MESSAGE_RECEIVED', label: 'A direct message arrives' },
  { value: 'COMMENT_RECEIVED', label: 'A comment arrives' },
  { value: 'LEAD_CREATED', label: 'A lead is detected' },
  { value: 'POST_FAILED', label: 'A post fails to publish' },
];
const ACTIONS = [
  { value: 'generate_reply', label: 'Draft a reply' },
  { value: 'auto_send', label: 'Send automatically (safety rules still apply)' },
  { value: 'require_approval', label: 'Require approval' },
  { value: 'disable_auto_reply', label: 'Never send automatically' },
  { value: 'escalate', label: 'Escalate to a person' },
  { value: 'notify', label: 'Notify the team' },
  { value: 'set_priority', label: 'Set priority' },
  { value: 'create_lead', label: 'Create a lead' },
  { value: 'mark_spam', label: 'Mark as spam' },
  { value: 'add_tag', label: 'Tag the contact' },
  { value: 'human_takeover', label: 'Switch conversation to human mode' },
];

function describeCondition(c: Condition) {
  if (c.field === 'confidence') return `confidence ${c.op === 'gte' ? '≥' : c.op === 'lte' ? '≤' : c.op === 'gt' ? '>' : '<'} ${Math.round(Number(c.value) * 100)}%`;
  if (c.field === 'text') return `text contains “${c.value}”`;
  if (c.op === 'in') return `${c.field} is ${(c.value as string[]).map(humanize).join(' or ')}`;
  return `${c.field} ${c.op === 'neq' ? 'is not' : 'is'} ${typeof c.value === 'string' ? humanize(c.value) : String(c.value)}`;
}

function RuleEditor({ rule, onClose }: { rule: AutomationRule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { clients, clientId, can } = useSession();
  const [name, setName] = useState(rule?.name ?? '');
  const [scope, setScope] = useState<string>(rule ? (rule.clientId ?? '') : (clientId ?? ''));
  const [trigger, setTrigger] = useState(rule?.trigger ?? 'MESSAGE_RECEIVED');
  const [platforms, setPlatforms] = useState<PlatformKey[]>(rule?.platforms ?? []);
  const [conditions, setConditions] = useState<Condition[]>(rule?.conditions ?? [{ field: 'intent', op: 'in', value: ['COMPLAINT'] }]);
  const [actions, setActions] = useState<Action[]>(rule?.actions ?? [{ type: 'escalate' }]);
  const [priority, setPriority] = useState(rule?.priority ?? 100);
  const [stop, setStop] = useState(rule?.stopProcessing ?? false);

  const save = useMutation({
    mutationFn: () => {
      const body = { name, clientId: scope || null, trigger, platforms, conditions, actions, priority, stopProcessing: stop, enabled: rule?.enabled ?? true };
      return rule ? api(`/automation/rules/${rule.id}`, { method: 'PATCH', body }) : api('/automation/rules', { body });
    },
    onSuccess: () => {
      toast.success('Rule saved');
      qc.invalidateQueries({ queryKey: ['rules'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const setCond = (i: number, patch: Partial<Condition>) => setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={rule ? 'Edit rule' : 'New rule'} wide footer={<Button loading={save.isPending} disabled={!name.trim() || !actions.length || !can('automation:manage')} onClick={() => save.mutate()}>Save rule</Button>}>
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="r-name"><Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Escalate complaints" /></Field>
          <Field label="Applies to" htmlFor="r-scope">
            <Select id="r-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Every client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="When" htmlFor="r-trigger">
          <Select id="r-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationRule['trigger'])}>
            {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>
        <div>
          <p className="mb-1.5 text-sm font-medium">On platforms</p>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.slice(0, 5).map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={platforms.includes(p)} onChange={() => setPlatforms((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]))} />
                <PlatformChip platform={p} size="sm" withName />
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-3">None selected means every platform.</p>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">If all of these are true</p>
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select aria-label="Field" className="w-40" value={c.field} onChange={(e) => setCond(i, { field: e.target.value, op: e.target.value === 'confidence' ? 'gte' : e.target.value === 'text' ? 'contains' : e.target.value === 'intent' ? 'in' : 'eq', value: e.target.value === 'confidence' ? 0.9 : e.target.value === 'intent' ? ['GENERAL_QUESTION'] : e.target.value === 'isSpam' || e.target.value === 'withinBusinessHours' ? true : '' })}>
                  <option value="intent">Intent</option>
                  <option value="confidence">AI confidence</option>
                  <option value="text">Message text</option>
                  <option value="isSpam">Is spam</option>
                  <option value="withinBusinessHours">During business hours</option>
                </Select>
                {c.field === 'intent' && (
                  <Select aria-label="Intent" className="w-56" value={(c.value as string[])[0]} onChange={(e) => setCond(i, { value: [e.target.value] })}>
                    {INTENTS.map((it) => <option key={it} value={it}>{humanize(it)}</option>)}
                  </Select>
                )}
                {c.field === 'confidence' && (
                  <>
                    <Select aria-label="Comparison" className="w-24" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                      <option value="gte">at least</option>
                      <option value="lt">below</option>
                    </Select>
                    <Input aria-label="Percent" type="number" min={0} max={100} className="w-24" value={Math.round(Number(c.value) * 100)} onChange={(e) => setCond(i, { value: Number(e.target.value) / 100 })} />
                    <span className="text-sm text-ink-3">%</span>
                  </>
                )}
                {c.field === 'text' && <Input aria-label="Contains" className="w-56" value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="contains…" />}
                {(c.field === 'isSpam' || c.field === 'withinBusinessHours') && (
                  <Select aria-label="Value" className="w-24" value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value === 'true' })}>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Select>
                )}
                <Button variant="ghost" size="icon" aria-label="Remove condition" onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={() => setConditions((cs) => [...cs, { field: 'confidence', op: 'gte', value: 0.9 }])}><Plus className="h-4 w-4" /> Add condition</Button>
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">Then</p>
          <div className="space-y-2">
            {actions.map((a, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select aria-label="Action" className="w-80" value={a.type} onChange={(e) => setActions((as) => as.map((x, j) => (j === i ? { type: e.target.value, ...(e.target.value === 'set_priority' ? { priority: 'HIGH' } : e.target.value === 'add_tag' ? { tag: 'vip' } : {}) } : x)))}>
                  {ACTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                {a.type === 'set_priority' && (
                  <Select aria-label="Priority" className="w-32" value={String(a.priority)} onChange={(e) => setActions((as) => as.map((x, j) => (j === i ? { ...x, priority: e.target.value } : x)))}>
                    {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
                  </Select>
                )}
                {a.type === 'add_tag' && <Input aria-label="Tag" className="w-40" value={String(a.tag)} onChange={(e) => setActions((as) => as.map((x, j) => (j === i ? { ...x, tag: e.target.value } : x)))} />}
                <Button variant="ghost" size="icon" aria-label="Remove action" onClick={() => setActions((as) => as.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={() => setActions((as) => [...as, { type: 'notify' }])}><Plus className="h-4 w-4" /> Add action</Button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Order" htmlFor="r-prio" hint="Lower numbers run first"><Input id="r-prio" type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} /> Stop checking later rules when this one matches</label>
        </div>
      </div>
    </Modal>
  );
}

export default function AutomationPage() {
  const { clientId, can, clients } = useSession();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<AutomationRule | null | 'new'>(null);
  const q = useQuery({ queryKey: ['rules', clientId], queryFn: () => api<AutomationRule[]>('/automation/rules', { query: { clientId } }) });
  const toggle = useMutation({ mutationFn: (r: AutomationRule) => api(`/automation/rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }), onError: (e) => toast.error(errorMessage(e)) });
  return (
    <>
      <PageHeader
        title="Automation"
        description="Rules run on every new message, comment, lead or failed post. Complaints, refunds, legal and abuse are always escalated unless you change that in a client’s AI settings."
        actions={can('automation:manage') && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> New rule</Button>}
      />
      <Panel>
        {q.isLoading && <div className="space-y-2 p-4">{[0, 1].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data?.length === 0 && <EmptyState icon={<Workflow className="h-8 w-8" />} title="No rules yet" description="For example: when a message's intent is Complaint, escalate and notify the team." />}
        <ul className="divide-y divide-line">
          {q.data?.map((r) => (
            <li key={r.id} className={`strip ${r.enabled ? 'strip-sky' : 'strip-idle'} flex flex-wrap items-start gap-4 px-5 py-4`}>
              <div className="min-w-0 flex-1">
                <button className="text-left font-medium hover:underline" onClick={() => setEditing(r)}>{r.name}</button>
                <p className="mt-1 text-sm text-ink-2">
                  When {TRIGGERS.find((t) => t.value === r.trigger)?.label.toLowerCase().replace(/^a /, 'a ')}
                  {r.platforms.length ? ` on ${r.platforms.map(humanize).join(', ')}` : ''}
                  {r.conditions.length ? `, if ${r.conditions.map(describeCondition).join(' and ')}` : ''}: {r.actions.map((a) => ACTIONS.find((o) => o.value === a.type)?.label.toLowerCase() ?? a.type).join(', ')}.
                </p>
                <p className="mt-1 text-xs text-ink-3">{r.clientId ? clients.find((c) => c.id === r.clientId)?.name : 'Every client'}, order {r.priority}, matched {r._count?.executions ?? 0} times</p>
              </div>
              <Badge tone={r.enabled ? 'sky' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge>
              {can('automation:manage') && (
                <>
                  <Switch label={`${r.enabled ? 'Turn off' : 'Turn on'} ${r.name}`} checked={r.enabled} onChange={() => toggle.mutate(r)} />
                  <ConfirmButton variant="ghost" title="Delete this rule?" description="It stops running immediately." confirmLabel="Delete rule" onConfirm={async () => { await api(`/automation/rules/${r.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['rules'] }); }}>
                    <Trash2 className="h-4 w-4" />
                  </ConfirmButton>
                </>
              )}
            </li>
          ))}
        </ul>
      </Panel>
      {editing && <RuleEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
