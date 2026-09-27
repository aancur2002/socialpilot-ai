'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, ErrorState, Field, Input, Panel, PanelHeader, Skeleton, Switch, Textarea } from './ui/primitives';
import { api, errorMessage } from '@/lib/api';

type Secret = { set: boolean; hint: string | null };

function useGroup<T>(group: string) {
  return useQuery({ queryKey: ['admin', 'platform', group], queryFn: () => api<T>(`/admin/platform/${group}`) });
}
function useSaveGroup(group: string, label: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: object) => api(`/admin/platform/${group}`, { method: 'PUT', body }),
    onSuccess: (data) => { qc.setQueryData(['admin', 'platform', group], data); toast.success(`${label} saved`); },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
/** Secret input: blank keeps the saved value. */
function SecretField({ id, label, secret, value, onChange, hint, placeholder }: { id: string; label: string; secret: Secret; value: string; onChange: (v: string) => void; hint?: string; placeholder?: string }) {
  return (
    <Field label={label} htmlFor={id} hint={secret.set ? `Saved (ending ${secret.hint}). Leave blank to keep it.${hint ? ` ${hint}` : ''}` : hint}>
      <Input id={id} type="password" autoComplete="new-password" placeholder={secret.set ? '••••••••' : placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

// ── Company & legal ───────────────────────────────────────────────────

interface Company { productName: string; legalName: string | null; address: string | null; supportEmail: string | null; website: string | null; jurisdiction: string | null }
interface Legal { terms: string | null; privacy: string | null; updatedOn: string | null }

export function CompanyLegalPanel() {
  const company = useGroup<Company>('company');
  const legal = useGroup<Legal>('legal');
  if (company.isLoading || legal.isLoading) return <Skeleton className="h-64" />;
  if (company.error || legal.error) return <ErrorState error={company.error ?? legal.error} />;
  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_1.4fr]">
      <CompanyForm initial={company.data!} />
      <LegalForm initial={legal.data!} />
    </div>
  );
}

function CompanyForm({ initial }: { initial: Company }) {
  const [f, setF] = useState({ productName: initial.productName, legalName: initial.legalName ?? '', address: initial.address ?? '', supportEmail: initial.supportEmail ?? '', website: initial.website ?? '', jurisdiction: initial.jurisdiction ?? '' });
  const save = useSaveGroup('company', 'Company details');
  return (
    <Panel>
      <PanelHeader title="Your company" description="Shown in emails, on the legal pages and on lead forms." />
      <div className="space-y-4 p-5">
        <Field label="Product name" htmlFor="co-product" hint="What customers see, e.g. in email subjects."><Input id="co-product" value={f.productName} onChange={(e) => setF({ ...f, productName: e.target.value })} /></Field>
        <Field label="Registered company name" htmlFor="co-legal"><Input id="co-legal" value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
        <Field label="Address" htmlFor="co-address"><Textarea id="co-address" rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Support email" htmlFor="co-email"><Input id="co-email" type="email" value={f.supportEmail} onChange={(e) => setF({ ...f, supportEmail: e.target.value })} /></Field>
          <Field label="Website" htmlFor="co-web"><Input id="co-web" placeholder="https://" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></Field>
        </div>
        <Field label="Governing law" htmlFor="co-law" hint="Country or state whose law applies to the Terms, e.g. Nepal or England and Wales."><Input id="co-law" value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: e.target.value })} /></Field>
        <Button loading={save.isPending} disabled={!f.productName.trim()} onClick={() => save.mutate(f)}>Save company details</Button>
      </div>
    </Panel>
  );
}

function LegalForm({ initial }: { initial: Legal }) {
  const [doc, setDoc] = useState<'terms' | 'privacy'>('terms');
  const [f, setF] = useState({ terms: initial.terms ?? '', privacy: initial.privacy ?? '' });
  const save = useSaveGroup('legal', 'Legal pages');
  const qc = useQueryClient();
  const loadTemplate = async () => {
    // The public endpoint returns the filled-in template while no custom text is saved.
    const pub = await api<{ terms: string; privacy: string; customTerms: boolean; customPrivacy: boolean }>('/public/legal');
    const custom = doc === 'terms' ? pub.customTerms : pub.customPrivacy;
    if (custom) return toast.message('Custom text is saved. Clear the box and save to go back to the template, then load it.');
    setF({ ...f, [doc]: pub[doc] });
  };
  return (
    <Panel>
      <PanelHeader
        title="Terms of Service and Privacy Policy"
        description="Public at /terms and /privacy, linked from sign-in and sign-up. Meta requires a privacy policy URL for App Review."
        actions={<div className="flex gap-2"><a href="/terms" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-clearance hover:underline"><ExternalLink className="h-4 w-4" /> Terms</a><a href="/privacy" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-clearance hover:underline"><ExternalLink className="h-4 w-4" /> Privacy</a></div>}
      />
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={doc === 'terms' ? 'primary' : 'secondary'} onClick={() => setDoc('terms')}>Terms</Button>
          <Button size="sm" variant={doc === 'privacy' ? 'primary' : 'secondary'} onClick={() => setDoc('privacy')}>Privacy</Button>
          {!f[doc] && <Badge tone="sky">Using the built-in template</Badge>}
        </div>
        <Textarea aria-label={doc === 'terms' ? 'Terms of Service text' : 'Privacy Policy text'} rows={16} className="font-mono text-xs" placeholder="Empty: the built-in template, filled with your company details, is shown. Paste your own text to replace it (Markdown: # heading, - list, **bold**)." value={f[doc]} onChange={(e) => setF({ ...f, [doc]: e.target.value })} />
        <p className="text-xs text-ink-3">The template is a starting point, not legal advice. Have your final text checked for your country, especially for payments and personal data.</p>
        <div className="flex flex-wrap gap-2">
          <Button loading={save.isPending} onClick={() => save.mutate({ terms: f.terms || null, privacy: f.privacy || null, updatedOn: new Date().toISOString().slice(0, 10) }, { onSuccess: () => qc.invalidateQueries({ queryKey: ['public-legal'] }) })}>Save legal pages</Button>
          {!f[doc] && <Button variant="secondary" onClick={loadTemplate}>Start from the template</Button>}
        </div>
      </div>
    </Panel>
  );
}

// ── Email ─────────────────────────────────────────────────────────────

interface Email { enabled: boolean; host: string | null; port: number; secure: boolean; user: string | null; password: Secret; fromName: string | null; fromEmail: string | null }

export function EmailPanel() {
  const q = useGroup<Email>('email');
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} />;
  return <EmailForm initial={q.data!} />;
}

function EmailForm({ initial }: { initial: Email }) {
  const [f, setF] = useState({ enabled: initial.enabled, host: initial.host ?? '', port: String(initial.port), secure: initial.secure, user: initial.user ?? '', password: '', fromName: initial.fromName ?? '', fromEmail: initial.fromEmail ?? '' });
  const [to, setTo] = useState('');
  const save = useSaveGroup('email', 'Email settings');
  const test = useMutation({
    mutationFn: () => api('/admin/platform/email/test', { body: { to } }),
    onSuccess: () => toast.success(`Test email sent to ${to}. Check the inbox (and spam).`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const body = () => ({ enabled: f.enabled, host: f.host || null, port: Number(f.port) || 587, secure: f.secure, user: f.user || null, ...(f.password ? { password: f.password } : {}), fromName: f.fromName || null, fromEmail: f.fromEmail || null });
  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1.4fr_1fr]">
      <Panel>
        <PanelHeader title="Email delivery (SMTP)" description="Sends invitations, password reset links, lead alerts and notifications." actions={initial.enabled && initial.host ? <Badge tone="clearance">On</Badge> : <Badge>Off: emails are only written to the server log</Badge>} />
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr]">
            <Field label="SMTP server" htmlFor="em-host" hint="From your email provider, e.g. smtp.resend.com, smtp.sendgrid.net, smtp.gmail.com."><Input id="em-host" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} /></Field>
            <Field label="Port" htmlFor="em-port" hint="587 (usual) or 465."><Input id="em-port" inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value, secure: e.target.value === '465' })} /></Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Username" htmlFor="em-user"><Input id="em-user" autoComplete="off" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} /></Field>
            <SecretField id="em-pass" label="Password or API key" secret={initial.password} value={f.password} onChange={(v) => setF({ ...f, password: v })} />
            <Field label="Sender name" htmlFor="em-from-name"><Input id="em-from-name" placeholder="SocialPilot" value={f.fromName} onChange={(e) => setF({ ...f, fromName: e.target.value })} /></Field>
            <Field label="Sender email" htmlFor="em-from" hint="Must be allowed by your provider (a verified domain)."><Input id="em-from" type="email" placeholder="hello@yourdomain.com" value={f.fromEmail} onChange={(e) => setF({ ...f, fromEmail: e.target.value })} /></Field>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Send emails" />
            <span className="text-sm">{f.enabled ? 'Send real emails' : 'Off'}</span>
          </div>
          <Button loading={save.isPending} disabled={f.enabled && (!f.host || !f.fromEmail)} onClick={() => save.mutate(body())}>Save email settings</Button>
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Send a test" description="Save first, then check that email arrives." />
        <div className="space-y-3 p-5">
          <Field label="Send to" htmlFor="em-to"><Input id="em-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Button variant="secondary" loading={test.isPending} disabled={!to} onClick={() => test.mutate()}>Send test email</Button>
          <p className="text-xs text-ink-3">Good providers for app email: Resend, Postmark, Amazon SES, SendGrid, Brevo. Gmail works for testing but has low daily limits.</p>
        </div>
      </Panel>
    </div>
  );
}

// ── Payments (Stripe: inactive until switched on) ─────────────────────

interface Stripe { enabled: boolean; publishableKey: string | null; secretKey: Secret; webhookSecret: Secret; webhookUrl: string }

export function PaymentsPanel() {
  const q = useGroup<Stripe>('stripe');
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} />;
  return <PaymentsForm initial={q.data!} />;
}

function PaymentsForm({ initial }: { initial: Stripe }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ publishableKey: initial.publishableKey ?? '', secretKey: '', webhookSecret: '' });
  const [checked, setChecked] = useState<string | null>(null);
  const save = useSaveGroup('stripe', 'Stripe keys');
  const check = useMutation({
    mutationFn: () => api<{ mode: string }>('/admin/platform/stripe/check', { body: {} }),
    onSuccess: (r) => { setChecked(r.mode); toast.success(`Keys work (${r.mode} mode)`); },
    onError: (e) => { setChecked(null); toast.error(errorMessage(e)); },
  });
  const enable = useMutation({
    mutationFn: (enabled: boolean) => api('/admin/platform/stripe/enabled', { method: 'PUT', body: { enabled } }),
    onSuccess: (data, enabled) => { qc.setQueryData(['admin', 'platform', 'stripe'], data); toast.success(enabled ? 'Card payments are on' : 'Card payments are off'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const webhookUrl = initial.webhookUrl;
  const configured = Boolean(initial.publishableKey && initial.secretKey.set && initial.webhookSecret.set);

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1.4fr_1fr]">
      <Panel>
        <PanelHeader title="Card payments (Stripe)" description="Optional. Customers pay by card from their billing page and the payment is recorded automatically." actions={initial.enabled ? <Badge tone="clearance">Active</Badge> : <Badge>Inactive</Badge>} />
        <div className="space-y-4 p-5">
          {!initial.enabled && <p className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-sm text-ink-2">Card payments are inactive. Customers see only your manual payment instructions (Plans &amp; billing). You can add keys now and switch this on later.</p>}
          <Field label="Publishable key" htmlFor="st-pk" hint="Stripe Dashboard → Developers → API keys. Starts with pk_test_ or pk_live_."><Input id="st-pk" value={f.publishableKey} onChange={(e) => setF({ ...f, publishableKey: e.target.value })} /></Field>
          <SecretField id="st-sk" label="Secret key" secret={initial.secretKey} value={f.secretKey} onChange={(v) => setF({ ...f, secretKey: v })} placeholder="sk_test_…" hint="A restricted key (rk_) with Checkout write access also works." />
          <SecretField id="st-wh" label="Webhook signing secret" secret={initial.webhookSecret} value={f.webhookSecret} onChange={(v) => setF({ ...f, webhookSecret: v })} placeholder="whsec_…" />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate({ publishableKey: f.publishableKey || null, ...(f.secretKey ? { secretKey: f.secretKey } : {}), ...(f.webhookSecret ? { webhookSecret: f.webhookSecret } : {}) }, { onSuccess: () => { setChecked(null); setF({ ...f, secretKey: '', webhookSecret: '' }); } })}>Save keys</Button>
            <Button variant="secondary" loading={check.isPending} disabled={!configured} onClick={() => check.mutate()}>Check keys</Button>
            {checked && <span className="inline-flex items-center gap-1 text-sm text-clearance"><CheckCircle2 className="h-4 w-4" /> Verified ({checked} mode)</span>}
          </div>
          <div className="flex items-center gap-3 border-t border-line pt-4">
            <Switch checked={initial.enabled} disabled={enable.isPending || (!initial.enabled && !configured)} onChange={(v) => enable.mutate(v)} label="Card payments active" />
            <span className="text-sm">{initial.enabled ? 'Active: customers can pay by card' : configured ? 'Switch on to let customers pay by card (the keys are checked first)' : 'Save all three keys to be able to switch this on'}</span>
          </div>
          <p className="text-xs text-ink-3">Saving new keys switches card payments off until they pass the check again.</p>
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Setting up Stripe later" />
        <ol className="list-decimal space-y-2 py-4 pl-9 pr-5 text-sm text-ink-2">
          <li>Create a Stripe account and finish its business verification.</li>
          <li>Copy the publishable and secret keys (use test keys first).</li>
          <li>In Stripe → Developers → Webhooks, add an endpoint: <code className="break-all">{webhookUrl}</code> with the events <code>checkout.session.completed</code> and <code>checkout.session.async_payment_succeeded</code>. Copy its signing secret.</li>
          <li>Paste the three values here, <strong>Save keys</strong>, <strong>Check keys</strong>, then switch card payments on.</li>
          <li>Make a small test payment from a customer&apos;s billing page and check it appears in their payments.</li>
        </ol>
        <p className="px-5 pb-4 text-xs text-ink-3">The webhook address must be your public API address (your API_URL), reachable over HTTPS.</p>
      </Panel>
    </div>
  );
}
