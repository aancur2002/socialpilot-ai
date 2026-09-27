'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Copy, ExternalLink, FileInput, KeyRound, Plus, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ClientSelect } from '@/components/client-select';
import { ago } from '@/components/domain';
import { ConfirmButton, Drawer, Modal } from '@/components/ui/overlay';
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, Skeleton, Switch, Table, Tabs, Td, Textarea, Th } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

type FieldType = 'text' | 'email' | 'phone' | 'textarea' | 'select';
interface FormField { key: string; label: string; type: FieldType; required: boolean; options?: string[] }
interface LeadForm {
  id: string;
  clientId: string;
  client: { id: string; name: string };
  name: string;
  publicKey: string;
  title: string | null;
  description: string | null;
  fields: FormField[];
  submitLabel: string;
  successMessage: string;
  redirectUrl: string | null;
  allowedDomains: string[];
  notifyEmails: string[];
  accentColor: string;
  active: boolean;
  submissions: number;
  createdAt: string;
}
interface ApiKeyRow { id: string; name: string; prefix: string; clientId: string; client: { name: string }; lastUsedAt: string | null; createdAt: string }
interface WebhookRow { id: string; name: string; url: string; clientId: string | null; events: string[]; active: boolean; lastStatus: number | null; lastError: string | null; lastDeliveredAt: string | null }

const DEFAULT_FIELDS: FormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'phone', label: 'Phone', type: 'phone', required: false },
  { key: 'message', label: 'How can we help?', type: 'textarea', required: false },
];
const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'textarea', label: 'Long text' },
  { value: 'select', label: 'Dropdown' },
];
const LEAD_FIELDS = ['name', 'email', 'phone', 'company', 'message'];
const EVENTS = [
  { value: 'lead.created', label: 'New lead' },
  { value: 'lead.status_changed', label: 'Stage changed' },
  { value: 'lead.updated', label: 'Any other change' },
];

function copy(text: string, what = 'Copied') {
  navigator.clipboard.writeText(text).then(() => toast.success(what), () => toast.error('Copy failed; select the text instead'));
}
const origin = () => (typeof window === 'undefined' ? '' : window.location.origin);

export default function LeadCapturePage() {
  const { can } = useSession();
  const [tab, setTab] = useState<'forms' | 'connect'>('forms');
  if (!can('leads:view')) return <EmptyState title="You don't have access to lead capture" />;
  return (
    <>
      <PageHeader title="Lead capture" description="Collect leads from your clients' websites and other tools. Every lead lands in Leads, with a notification." />
      <div className="mb-4">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'forms', label: 'Website forms' }, ...(can('leads:manage') ? [{ value: 'connect' as const, label: 'API & webhooks' }] : [])]} />
      </div>
      {tab === 'forms' ? <Forms /> : <Connectors />}
    </>
  );
}

// ── Forms ─────────────────────────────────────────────────────────────

function Forms() {
  const { can, clientId } = useSession();
  const q = useQuery({ queryKey: ['lead-forms', clientId], queryFn: () => api<LeadForm[]>('/lead-forms', { query: { clientId } }) });
  const [editing, setEditing] = useState<LeadForm | 'new' | null>(null);
  const [sharing, setSharing] = useState<LeadForm | null>(null);

  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <Panel>
      <PanelHeader
        title="Website forms"
        description="Put a form on a client's website, or share its link. Submissions become leads."
        actions={can('leads:manage') && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> New form</Button>}
      />
      {q.data!.length === 0 ? (
        <EmptyState icon={<FileInput className="h-6 w-6" />} title="No forms yet" description="Create a contact or quote form, then paste one line of code into the client's website." action={can('leads:manage') ? <Button onClick={() => setEditing('new')}>Create a form</Button> : undefined} />
      ) : (
        <Table>
          <thead><tr><Th>Form</Th><Th>Client</Th><Th className="text-right">Submissions</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {q.data!.map((f) => (
              <tr key={f.id}>
                <Td><p className="font-medium">{f.name}</p><p className="text-xs text-ink-3">{f.fields.length} fields, created {ago(f.createdAt)}</p></Td>
                <Td>{f.client.name}</Td>
                <Td className="text-right tabular-nums">{f.submissions}</Td>
                <Td>{f.active ? <Badge tone="clearance">Live</Badge> : <Badge>Paused</Badge>}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button variant="secondary" size="sm" onClick={() => setSharing(f)}>Get code</Button>{' '}
                  {can('leads:manage') && <Button variant="ghost" size="sm" onClick={() => setEditing(f)}>Edit</Button>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing && <FormEditor form={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(f) => { setEditing(null); setSharing(f); }} />}
      {sharing && <ShareForm form={sharing} onClose={() => setSharing(null)} />}
    </Panel>
  );
}

function ShareForm({ form, onClose }: { form: LeadForm; onClose: () => void }) {
  const link = `${origin()}/f/${form.publicKey}`;
  const embed = `<div data-socialpilot-form="${form.publicKey}"></div>\n<script src="${origin()}/embed/form.js" async></script>`;
  const iframe = `<iframe src="${link}" title="${form.title ?? form.name}" style="width:100%;min-height:640px;border:0"></iframe>`;
  const Snippet = ({ label, code, hint }: { label: string; code: string; hint: string }) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{label}</h3>
        <Button variant="ghost" size="sm" onClick={() => copy(code, `${label} copied`)}><Copy className="h-4 w-4" /> Copy</Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[var(--radius-control)] border border-line bg-surface-2 p-3 text-xs">{code}</pre>
      <p className="text-xs text-ink-3">{hint}</p>
    </div>
  );
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Add "${form.name}" to a website`} wide footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-5">
        {!form.active && <p className="text-sm text-runway">This form is paused, so it won't show or accept submissions until you turn it back on.</p>}
        <Snippet label="Embed code (recommended)" code={embed} hint="Paste where the form should appear, in any website builder's HTML or code block (WordPress, Wix, Squarespace, Webflow, Shopify). It adapts to the page and doesn't clash with the site's styles." />
        <Snippet label="Iframe" code={iframe} hint="Use this if the website only allows iframes." />
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Shareable link</h3>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => copy(link, 'Link copied')}><Copy className="h-4 w-4" /> Copy</Button>
              <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded px-2 text-sm text-clearance hover:underline"><ExternalLink className="h-4 w-4" /> Open</a>
            </div>
          </div>
          <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Form link" />
          <p className="text-xs text-ink-3">For Instagram bios, Facebook buttons, WhatsApp messages, QR codes and email signatures.</p>
        </div>
      </div>
    </Modal>
  );
}

function FormEditor({ form, onClose, onSaved }: { form: LeadForm | null; onClose: () => void; onSaved: (f: LeadForm) => void }) {
  const qc = useQueryClient();
  const { clientId: scope } = useSession();
  const [f, setF] = useState({
    clientId: form?.clientId ?? scope ?? '',
    name: form?.name ?? 'Contact form',
    title: form?.title ?? '',
    description: form?.description ?? '',
    fields: form?.fields ?? DEFAULT_FIELDS,
    submitLabel: form?.submitLabel ?? 'Send',
    successMessage: form?.successMessage ?? "Thanks! We'll be in touch soon.",
    redirectUrl: form?.redirectUrl ?? '',
    allowedDomains: (form?.allowedDomains ?? []).join(', '),
    notifyEmails: (form?.notifyEmails ?? []).join(', '),
    accentColor: form?.accentColor ?? '#0f766e',
    active: form?.active ?? true,
  });
  const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name, title: f.title || null, description: f.description || null, fields: f.fields, submitLabel: f.submitLabel, successMessage: f.successMessage,
        redirectUrl: f.redirectUrl || null, allowedDomains: list(f.allowedDomains), notifyEmails: list(f.notifyEmails), accentColor: f.accentColor, active: f.active,
      };
      return form ? api<LeadForm>(`/lead-forms/${form.id}`, { method: 'PATCH', body }) : api<LeadForm>('/lead-forms', { body: { ...body, clientId: f.clientId } });
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['lead-forms'] });
      toast.success(form ? 'Form saved' : 'Form created');
      onSaved(saved);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const setField = (i: number, patch: Partial<FormField>) => setF({ ...f, fields: f.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const move = (i: number, d: -1 | 1) => {
    const next = [...f.fields];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setF({ ...f, fields: next });
  };
  const addField = () => {
    let n = f.fields.length + 1;
    while (f.fields.some((x) => x.key === `field_${n}`)) n++;
    setF({ ...f, fields: [...f.fields, { key: `field_${n}`, label: 'New question', type: 'text', required: false }] });
  };
  const hasContact = f.fields.some((x) => x.key === 'email' || x.key === 'phone');
  const extraKey = (i: number) => {
    let n = i + 1;
    while (f.fields.some((x) => x.key === `field_${n}`)) n++;
    return `field_${n}`;
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={form ? `Edit ${form.name}` : 'New form'} wide footer={<Button loading={save.isPending} disabled={!f.clientId || !f.name || !hasContact} onClick={() => save.mutate()}>{form ? 'Save form' : 'Create form'}</Button>}>
      <div className="space-y-6">
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!form && <Field label="Client" htmlFor="lf-client"><ClientSelect id="lf-client" value={f.clientId || null} onChange={(v) => setF({ ...f, clientId: v ?? '' })} /></Field>}
          <Field label="Form name (only you see this)" htmlFor="lf-name"><Input id="lf-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Heading on the form" htmlFor="lf-title" hint="Empty: “Contact <client name>”."><Input id="lf-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Accent colour" htmlFor="lf-color"><div className="flex gap-2"><input type="color" aria-label="Pick accent colour" value={f.accentColor} onChange={(e) => setF({ ...f, accentColor: e.target.value })} className="h-9 w-12 rounded border border-line" /><Input id="lf-color" value={f.accentColor} onChange={(e) => setF({ ...f, accentColor: e.target.value })} /></div></Field>
          <div className="sm:col-span-2"><Field label="Intro text" htmlFor="lf-desc"><Textarea id="lf-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Questions</h3>
            <Button variant="secondary" size="sm" onClick={addField} disabled={f.fields.length >= 20}><Plus className="h-4 w-4" /> Add question</Button>
          </div>
          {!hasContact && <p className="text-sm text-alert">Keep an Email or Phone question (key “email” or “phone”) so you can reach the lead.</p>}
          <div className="space-y-2">
            {f.fields.map((field, i) => (
              <div key={i} className="rounded-[var(--radius-control)] border border-line p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr_auto]">
                  <Input aria-label={`Question ${i + 1} label`} value={field.label} onChange={(e) => setField(i, { label: e.target.value })} />
                  <Select aria-label={`Question ${i + 1} type`} value={field.type} onChange={(e) => setField(i, { type: e.target.value as FieldType, ...(e.target.value === 'select' && !field.options?.length ? { options: ['Option 1', 'Option 2'] } : {}) })}>
                    {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </Select>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === f.fields.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label="Remove question" onClick={() => setF({ ...f, fields: f.fields.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={field.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required</label>
                  <label className="flex items-center gap-2 text-ink-2">
                    Saves to
                    <Select aria-label={`Question ${i + 1} saves to`} className="h-8 w-auto" value={LEAD_FIELDS.includes(field.key) ? field.key : ''} onChange={(e) => setField(i, { key: e.target.value || extraKey(i) })}>
                      {LEAD_FIELDS.map((k) => <option key={k} value={k} disabled={k !== field.key && f.fields.some((x) => x.key === k)}>{k[0]!.toUpperCase() + k.slice(1)}</option>)}
                      <option value="">Extra answer</option>
                    </Select>
                  </label>
                </div>
                {field.type === 'select' && (
                  <Input className="mt-2" aria-label={`Question ${i + 1} options`} placeholder="Options, separated by commas" value={(field.options ?? []).join(', ')} onChange={(e) => setField(i, { options: e.target.value.split(',').map((o) => o.trimStart()) })} onBlur={(e) => setField(i, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })} />
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-3">“Saves to” puts the answer in that lead field. Extra answers are kept with the lead and shown on it.</p>
        </section>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Button text" htmlFor="lf-submit"><Input id="lf-submit" value={f.submitLabel} onChange={(e) => setF({ ...f, submitLabel: e.target.value })} /></Field>
          <Field label="After sending, go to (optional)" htmlFor="lf-redirect" hint="A thank-you page on their website."><Input id="lf-redirect" placeholder="https://" value={f.redirectUrl} onChange={(e) => setF({ ...f, redirectUrl: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Thank-you message" htmlFor="lf-success"><Input id="lf-success" value={f.successMessage} onChange={(e) => setF({ ...f, successMessage: e.target.value })} /></Field></div>
          <Field label="Also email new leads to" htmlFor="lf-notify" hint="Separate addresses with commas. Your team is notified in the app either way."><Input id="lf-notify" value={f.notifyEmails} onChange={(e) => setF({ ...f, notifyEmails: e.target.value })} /></Field>
          <Field label="Only allow on these websites" htmlFor="lf-domains" hint="e.g. bellasbakery.com. Empty: any website. Stops others copying the form."><Input id="lf-domains" value={f.allowedDomains} onChange={(e) => setF({ ...f, allowedDomains: e.target.value })} /></Field>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Form accepts submissions" />
            <span className="text-sm">{f.active ? 'Live: accepting submissions' : 'Paused: hidden and not accepting submissions'}</span>
          </div>
        </section>

        {form && (
          <section className="border-t border-line pt-5">
            <ConfirmButton title={`Delete ${form.name}?`} description="The form stops working on every website it's on. Leads it already collected are kept." confirmLabel="Delete form"
              onConfirm={async () => { await api(`/lead-forms/${form.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['lead-forms'] }); onClose(); }}>
              Delete form
            </ConfirmButton>
          </section>
        )}
      </div>
    </Drawer>
  );
}

// ── API keys and webhooks ─────────────────────────────────────────────

function Connectors() {
  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
      <ApiKeys />
      <Webhooks />
    </div>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const { clientId: scope } = useSession();
  const q = useQuery({ queryKey: ['lead-api-keys'], queryFn: () => api<ApiKeyRow[]>('/lead-api-keys') });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ clientId: scope ?? '', name: 'Zapier' });
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ key: string; name: string }>('/lead-api-keys', { body: form }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['lead-api-keys'] }); setCreated(r); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const curl = (key: string) => `curl -X POST ${origin()}/api/v1/public/leads \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"Ana Lee","email":"ana@example.com","phone":"+1 555 0100","message":"Wedding cake for 80","source":"website"}'`;

  return (
    <Panel>
      <PanelHeader title="Lead API" description="Send leads in from Zapier, Make, a website backend or any tool that can make a web request." actions={<Button size="sm" onClick={() => { setCreated(null); setCreating(true); }}><KeyRound className="h-4 w-4" /> New key</Button>} />
      {q.isLoading ? <Skeleton className="m-5 h-24" /> : q.data!.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-2">No keys yet. Each key adds leads to one client.</p>
      ) : (
        <Table>
          <tbody>
            {q.data!.map((k) => (
              <tr key={k.id}>
                <Td><p className="font-medium">{k.name}</p><p className="text-xs text-ink-3"><code>{k.prefix}…</code> for {k.client.name}</p></Td>
                <Td className="text-sm text-ink-2">{k.lastUsedAt ? `Used ${ago(k.lastUsedAt)}` : 'Never used'}</Td>
                <Td className="text-right">
                  <ConfirmButton title={`Revoke ${k.name}?`} description="Anything using this key stops sending leads immediately." confirmLabel="Revoke key" onConfirm={async () => { await api(`/lead-api-keys/${k.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['lead-api-keys'] }); }}>Revoke</ConfirmButton>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <details className="border-t border-line px-5 py-4 text-sm">
        <summary className="cursor-pointer font-medium">How to send a lead</summary>
        <div className="mt-3 space-y-2 text-ink-2">
          <p>POST JSON to <code>{origin()}/api/v1/public/leads</code> with the header <code>Authorization: Bearer YOUR_KEY</code>.</p>
          <p>Fields: <code>name</code>, <code>email</code>, <code>phone</code> (email or phone required), <code>company</code>, <code>message</code>, <code>source</code>, <code>value</code>, <code>tags</code> (list), <code>fields</code> (extra answers as an object), <code>pageUrl</code>, <code>utm_source</code>, <code>utm_medium</code>, <code>utm_campaign</code>.</p>
          <p>In Zapier or Make, use a “Webhooks: POST” step with those fields. A repeat email or phone is added to the existing open lead.</p>
        </div>
      </details>
      {creating && (
        <Modal open onOpenChange={(o) => !o && setCreating(false)} title={created ? 'Copy your key now' : 'New API key'} wide footer={created ? <Button onClick={() => setCreating(false)}>Done</Button> : <Button loading={create.isPending} disabled={!form.clientId || !form.name} onClick={() => create.mutate()}>Create key</Button>}>
          {created ? (
            <div className="space-y-3 text-sm">
              <p><strong>This key is shown only once.</strong> Store it in the tool that sends leads.</p>
              <div className="flex items-center gap-2"><Input readOnly value={created.key} onFocus={(e) => e.currentTarget.select()} aria-label="API key" /><Button variant="secondary" onClick={() => copy(created.key, 'Key copied')}><Copy className="h-4 w-4" /></Button></div>
              <h3 className="font-medium">Test it</h3>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[var(--radius-control)] border border-line bg-surface-2 p-3 text-xs">{curl(created.key)}</pre>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Leads go to client" htmlFor="ak-client"><ClientSelect id="ak-client" value={form.clientId || null} onChange={(v) => setForm({ ...form, clientId: v ?? '' })} /></Field>
              <Field label="Name" htmlFor="ak-name" hint="Where it's used, e.g. Zapier or Website."><Input id="ak-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            </div>
          )}
        </Modal>
      )}
    </Panel>
  );
}

function Webhooks() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lead-webhooks'], queryFn: () => api<WebhookRow[]>('/lead-webhooks') });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', clientId: null as string | null, events: ['lead.created'] });
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ secret: string }>('/lead-webhooks', { body: form }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['lead-webhooks'] }); setSecret(r.secret); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (h: WebhookRow) => api(`/lead-webhooks/${h.id}`, { method: 'PATCH', body: { active: !h.active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-webhooks'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: (id: string) => api<{ status?: number }>(`/lead-webhooks/${id}/test`, { body: {} }),
    onSuccess: (r) => { toast.success(`Delivered (HTTP ${r.status ?? 'ok'})`); qc.invalidateQueries({ queryKey: ['lead-webhooks'] }); },
    onError: (e) => { toast.error(errorMessage(e)); qc.invalidateQueries({ queryKey: ['lead-webhooks'] }); },
  });

  return (
    <Panel>
      <PanelHeader title="Webhooks" description="Push leads to another CRM, Google Sheets (via Zapier or Make), Slack or your own system." actions={<Button size="sm" onClick={() => { setSecret(null); setForm({ name: '', url: '', clientId: null, events: ['lead.created'] }); setCreating(true); }}><Webhook className="h-4 w-4" /> New webhook</Button>} />
      {q.isLoading ? <Skeleton className="m-5 h-24" /> : q.data!.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-2">No webhooks yet.</p>
      ) : (
        <Table>
          <tbody>
            {q.data!.map((h) => (
              <tr key={h.id}>
                <Td>
                  <p className="font-medium">{h.name}</p>
                  <p className="max-w-xs truncate text-xs text-ink-3">{h.url}</p>
                  <p className="text-xs text-ink-3">{h.events.map((e) => EVENTS.find((x) => x.value === e)?.label ?? e).join(', ')}</p>
                </Td>
                <Td className="text-sm">
                  {h.lastDeliveredAt ? (h.lastError ? <span className="text-alert">Failed {ago(h.lastDeliveredAt)}: {h.lastError}</span> : <span className="text-ink-2">Delivered {ago(h.lastDeliveredAt)}</span>) : <span className="text-ink-3">Not sent yet</span>}
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Switch checked={h.active} onChange={() => toggle.mutate(h)} label={`${h.name} active`} />{' '}
                  <Button variant="ghost" size="sm" loading={test.isPending && test.variables === h.id} onClick={() => test.mutate(h.id)}>Test</Button>
                  <ConfirmButton title={`Delete ${h.name}?`} description="Leads stop being sent to this address." confirmLabel="Delete webhook" onConfirm={async () => { await api(`/lead-webhooks/${h.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['lead-webhooks'] }); }}>Delete</ConfirmButton>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <details className="border-t border-line px-5 py-4 text-sm">
        <summary className="cursor-pointer font-medium">What gets sent</summary>
        <div className="mt-3 space-y-2 text-ink-2">
          <p>A POST with JSON <code>{'{ event, sentAt, data: { id, client, status, name, email, phone, company, message, fields, tags, value, utm, … } }'}</code>. Failed deliveries are retried for about half an hour.</p>
          <p>Each request has an <code>X-SocialPilot-Signature</code> header (<code>t=timestamp,v1=hex</code>): an HMAC-SHA256 of <code>timestamp.body</code> with your signing secret. Check it to be sure the request came from here.</p>
        </div>
      </details>
      {creating && (
        <Modal open onOpenChange={(o) => !o && setCreating(false)} title={secret ? 'Webhook created' : 'New webhook'} wide footer={secret ? <Button onClick={() => setCreating(false)}>Done</Button> : <Button loading={create.isPending} disabled={!form.name || !form.url || !form.events.length} onClick={() => create.mutate()}>Create webhook</Button>}>
          {secret ? (
            <div className="space-y-3 text-sm">
              <p>Signing secret (<strong>shown only once</strong>). Use it to verify requests, or ignore it if the receiving tool doesn't check signatures.</p>
              <div className="flex items-center gap-2"><Input readOnly value={secret} onFocus={(e) => e.currentTarget.select()} aria-label="Signing secret" /><Button variant="secondary" onClick={() => copy(secret, 'Secret copied')}><Copy className="h-4 w-4" /></Button></div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="wh-name"><Input id="wh-name" placeholder="e.g. Google Sheets" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Clients" htmlFor="wh-client"><ClientSelect id="wh-client" value={form.clientId} onChange={(v) => setForm({ ...form, clientId: v })} allLabel="All clients" /></Field>
              <div className="sm:col-span-2"><Field label="URL" htmlFor="wh-url" hint="The address the other tool gives you, e.g. a Zapier “Catch Hook” URL."><Input id="wh-url" placeholder="https://hooks.zapier.com/…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field></div>
              <fieldset className="sm:col-span-2">
                <legend className="mb-1.5 text-sm font-medium">Send when</legend>
                <div className="flex flex-wrap gap-4 text-sm">
                  {EVENTS.map((ev) => (
                    <label key={ev.value} className="flex items-center gap-2">
                      <input type="checkbox" checked={form.events.includes(ev.value)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev.value] : form.events.filter((x) => x !== ev.value) })} />
                      {ev.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          )}
        </Modal>
      )}
    </Panel>
  );
}

