'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INTENTS, type IntentKey } from '@socialpilot/validation';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { humanize } from '@/components/domain';
import { SocialAccountsPanel } from '@/components/social';
import { TimezoneSelect } from '@/components/timezone-select';
import { ConfirmButton } from '@/components/ui/overlay';
import { Button, cn, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, Skeleton, Switch, Tabs, Textarea } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { BrandProfile, Client, ClientSettings } from '@/lib/types';

const list = (s: string) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

function GeneralForm({ client }: { client: Client }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [name, setName] = useState(client.name);
  const [timezone, setTimezone] = useState(client.timezone);
  const dirty = name !== client.name || timezone !== client.timezone;
  const save = useMutation({
    mutationFn: () => api<Client>(`/clients/${client.id}`, { method: 'PATCH', body: { name, timezone } }),
    onSuccess: () => {
      toast.success('Client updated');
      qc.invalidateQueries({ queryKey: ['client', client.id] });
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Panel className="max-w-2xl">
      <PanelHeader title="General" description="The timezone is used for scheduling, the calendar and business hours." actions={can('clients:edit') && <Button disabled={!dirty || !name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>} />
      <div className="space-y-4 p-5">
        <Field label="Client name" htmlFor="g-name"><Input id="g-name" value={name} disabled={!can('clients:edit')} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Timezone" htmlFor="g-tz"><TimezoneSelect id="g-tz" value={timezone} disabled={!can('clients:edit')} onChange={setTimezone} /></Field>
      </div>
    </Panel>
  );
}

function BrandForm({ client }: { client: Client }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const b = client.brandProfile;
  const [f, setF] = useState({
    brandName: b?.brandName ?? client.name,
    industry: b?.industry ?? '',
    description: b?.description ?? '',
    tone: b?.tone ?? '',
    targetAudience: b?.targetAudience ?? '',
    services: (b?.services ?? []).join('\n'),
    products: (b?.products ?? []).join('\n'),
    location: b?.location ?? '',
    website: b?.website ?? '',
    phone: b?.phone ?? '',
    email: b?.email ?? '',
    brandRules: (b?.brandRules ?? []).join('\n'),
    forbiddenTopics: (b?.forbiddenTopics ?? []).join('\n'),
    preferredHashtags: (b?.preferredHashtags ?? []).join(' '),
    cta: b?.cta ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      api<BrandProfile>(`/clients/${client.id}/brand`, {
        method: 'PUT',
        body: {
          ...f,
          industry: f.industry || null,
          description: f.description || null,
          tone: f.tone || null,
          targetAudience: f.targetAudience || null,
          location: f.location || null,
          website: f.website || null,
          phone: f.phone || null,
          email: f.email || null,
          cta: f.cta || null,
          services: list(f.services),
          products: list(f.products),
          brandRules: list(f.brandRules),
          forbiddenTopics: list(f.forbiddenTopics),
          preferredHashtags: f.preferredHashtags.split(/[\s,]+/).filter(Boolean),
        },
      }),
    onSuccess: () => {
      toast.success('Brand profile saved');
      qc.invalidateQueries({ queryKey: ['client', client.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const input = (key: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} htmlFor={key} hint={hint}>
      <Input id={key} value={f[key]} disabled={!can('clients:edit')} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </Field>
  );
  const area = (key: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} htmlFor={key} hint={hint}>
      <Textarea id={key} value={f[key]} disabled={!can('clients:edit')} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </Field>
  );
  return (
    <Panel>
      <PanelHeader title="Brand profile" description="The AI uses only these facts plus the knowledge base. Anything missing is flagged instead of invented." actions={can('clients:edit') && <Button loading={save.isPending} onClick={() => save.mutate()}>Save profile</Button>} />
      <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
        {input('brandName', 'Brand name')}
        {input('industry', 'Industry')}
        <div className="md:col-span-2">{area('description', 'Description')}</div>
        {input('tone', 'Tone of voice')}
        {input('targetAudience', 'Target audience')}
        {area('services', 'Services', 'One per line')}
        {area('products', 'Products', 'One per line')}
        {input('location', 'Location')}
        {input('website', 'Website')}
        {input('phone', 'Phone')}
        {input('email', 'Email')}
        {area('brandRules', 'Brand rules', 'One per line, e.g. never promise same-day delivery')}
        {area('forbiddenTopics', 'Topics to avoid', 'One per line')}
        {input('preferredHashtags', 'Preferred hashtags', 'Separate with spaces')}
        {input('cta', 'Default call to action')}
      </div>
    </Panel>
  );
}

function IntentPicker({ value, onChange, disabled }: { value: IntentKey[]; onChange: (v: IntentKey[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {INTENTS.filter((i) => i !== 'SPAM').map((i) => {
        const on = value.includes(i);
        return (
          <button key={i} type="button" disabled={disabled} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== i) : [...value, i])} className={cn('rounded-full border px-2.5 py-1 text-xs', on ? 'border-clearance bg-clearance-soft text-clearance' : 'border-line text-ink-2 hover:bg-surface-2')}>
            {humanize(i)}
          </button>
        );
      })}
    </div>
  );
}

function AiSettingsForm({ client }: { client: Client }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [s, setS] = useState<ClientSettings>(client.settings!);
  useEffect(() => setS(client.settings!), [client.settings]);
  const canAuto = can('messages:auto_reply');
  const save = useMutation({
    mutationFn: () => {
      const { businessHours, ...rest } = s;
      const cleaned = Object.fromEntries(Object.entries(businessHours).filter(([, v]) => v && v.length));
      const body: Partial<ClientSettings> = { ...rest, businessHours: cleaned };
      if (!canAuto) {
        delete body.autoReplyEnabled;
        delete body.autoReplyThreshold;
        delete body.allowedAutoIntents;
        delete body.escalationIntents;
      }
      return api(`/clients/${client.id}/settings`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      toast.success('AI settings saved');
      qc.invalidateQueries({ queryKey: ['client', client.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = (key: 'aiEnabled' | 'autoReplyEnabled' | 'humanApprovalRequired' | 'autoPublishEnabled', label: string, hint: string, disabled = false) => (
    <div className="flex items-start justify-between gap-4">
      <div><p className="text-sm font-medium">{label}</p><p className="text-sm text-ink-2">{hint}</p></div>
      <Switch label={label} checked={s[key]} disabled={disabled || !can('clients:edit')} onChange={(v) => setS({ ...s, [key]: v })} />
    </div>
  );
  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader title="Automation level" actions={can('clients:edit') && <Button loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>} />
        <div className="space-y-5 p-5">
          {toggle('aiEnabled', 'AI drafting', 'Draft posts and reply suggestions with AI.')}
          {toggle('humanApprovalRequired', 'Require approval before publishing', 'A person must approve each post before it can be scheduled.')}
          {toggle('autoReplyEnabled', 'Automatic replies', 'Send confident replies to allowed intents without review.', !canAuto)}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={`Send automatically at ${Math.round(s.autoReplyThreshold * 100)}% confidence or higher`} htmlFor="auto-t">
              <input id="auto-t" type="range" min={50} max={100} value={Math.round(s.autoReplyThreshold * 100)} disabled={!canAuto} onChange={(e) => setS({ ...s, autoReplyThreshold: Number(e.target.value) / 100, approvalThreshold: Math.min(s.approvalThreshold, Number(e.target.value) / 100) })} className="w-full accent-[var(--clearance)]" />
            </Field>
            <Field label={`Hand to a person below ${Math.round(s.approvalThreshold * 100)}%`} htmlFor="appr-t" hint="Between the two values, replies wait for approval.">
              <input id="appr-t" type="range" min={0} max={Math.round(s.autoReplyThreshold * 100)} value={Math.round(s.approvalThreshold * 100)} disabled={!can('clients:edit')} onChange={(e) => setS({ ...s, approvalThreshold: Number(e.target.value) / 100 })} className="w-full accent-[var(--clearance)]" />
            </Field>
          </div>
          <p className="text-xs text-ink-3">Confidence is the model’s own estimate used for routing. It is not a guarantee of accuracy, so safety rules below always apply first.</p>
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Which messages" />
        <div className="space-y-5 p-5">
          <Field label="Allowed for automatic replies" htmlFor="allowed"><IntentPicker value={s.allowedAutoIntents} disabled={!canAuto} onChange={(v) => setS({ ...s, allowedAutoIntents: v })} /></Field>
          <Field label="Always hand to a person" htmlFor="esc" hint="These are escalated even at high confidence. Threats and sensitive personal data are always escalated."><IntentPicker value={s.escalationIntents} disabled={!canAuto} onChange={(v) => setS({ ...s, escalationIntents: v })} /></Field>
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Voice and hours" description={`Times are in ${client.timezone}. Leave a day empty for closed; leave all empty for always open.`} />
        <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
          <Field label="Default tone" htmlFor="dtone"><Input id="dtone" value={s.defaultTone ?? ''} onChange={(e) => setS({ ...s, defaultTone: e.target.value || null })} /></Field>
          <Field label="Default language" htmlFor="dlang"><Input id="dlang" value={s.defaultLanguage} onChange={(e) => setS({ ...s, defaultLanguage: e.target.value })} /></Field>
          <div className="space-y-2 md:col-span-2">
            {DAYS.map((d) => {
              const range = s.businessHours[d]?.[0];
              return (
                <div key={d} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="w-24">{humanize(d)}</span>
                  <Input aria-label={`${d} opens`} type="time" className="w-32" value={range?.start ?? ''} onChange={(e) => setS({ ...s, businessHours: { ...s.businessHours, [d]: e.target.value ? [{ start: e.target.value, end: range?.end ?? '18:00' }] : [] } })} />
                  <span className="text-ink-3">to</span>
                  <Input aria-label={`${d} closes`} type="time" className="w-32" value={range?.end ?? ''} disabled={!range} onChange={(e) => setS({ ...s, businessHours: { ...s.businessHours, [d]: [{ start: range?.start ?? '09:00', end: e.target.value }] } })} />
                </div>
              );
            })}
          </div>
          <Field label="Outside business hours" htmlFor="afterhours">
            <Select id="afterhours" value={s.afterHoursMode} onChange={(e) => setS({ ...s, afterHoursMode: e.target.value as ClientSettings['afterHoursMode'] })}>
              <option value="REPLY_NORMALLY">Reply as usual</option>
              <option value="SEND_AFTER_HOURS_MESSAGE">Send the after-hours message, hold the full reply for approval</option>
              <option value="QUEUE_FOR_BUSINESS_HOURS">Hold automatic replies until opening time</option>
            </Select>
          </Field>
          <Field label="After-hours message" htmlFor="ahmsg"><Textarea id="ahmsg" value={s.afterHoursMessage ?? ''} onChange={(e) => setS({ ...s, afterHoursMessage: e.target.value || null })} /></Field>
        </div>
      </Panel>
    </div>
  );
}

function Workspace() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = useSession();
  const [tab, setTab] = useState<'general' | 'brand' | 'ai' | 'accounts'>((params.get('tab') as 'general' | 'brand' | 'ai' | 'accounts') ?? 'general');
  const q = useQuery({ queryKey: ['client', id], queryFn: () => api<Client>(`/clients/${id}`) });
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data!;
  return (
    <>
      <PageHeader
        title={c.name}
        description={`Timezone ${c.timezone}`}
        actions={
          can('clients:delete') && (
            <ConfirmButton title={`Archive ${c.name}?`} description="The client disappears from lists and its scheduled posts stay as they are. You can restore it from the API." confirmLabel="Archive client" onConfirm={async () => { await api(`/clients/${id}`, { method: 'PATCH', body: { status: 'ARCHIVED' } }); qc.invalidateQueries({ queryKey: ['clients'] }); router.replace('/clients'); }}>
              Archive
            </ConfirmButton>
          )
        }
      />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} items={[{ value: 'general', label: 'General' }, { value: 'brand', label: 'Brand' }, { value: 'ai', label: 'AI settings' }, { value: 'accounts', label: 'Social accounts' }]} /></div>
      {tab === 'general' && <GeneralForm key={c.updatedAt} client={c} />}
      {tab === 'brand' && <BrandForm client={c} />}
      {tab === 'ai' && c.settings && <AiSettingsForm client={c} />}
      {tab === 'accounts' && <SocialAccountsPanel clientId={c.id} />}
    </>
  );
}

export default function ClientWorkspacePage() {
  return (
    <Suspense>
      <Workspace />
    </Suspense>
  );
}
