'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AccessBadge, money, type Access } from './billing';
import { ago, humanize, when } from './domain';
import { ConfirmButton, Drawer, Modal } from './ui/overlay';
import { Badge, Button, EmptyState, ErrorState, Field, Input, Panel, PanelHeader, Select, Skeleton, Switch, Table, Td, Textarea, Th } from './ui/primitives';
import { api, errorMessage } from '@/lib/api';

const PLANS = ['FREE', 'STARTER', 'PRO', 'AGENCY', 'ENTERPRISE'] as const;
const METHODS = ['bank_transfer', 'cash', 'card', 'upi', 'paypal', 'other'] as const;

interface CustomerRow {
  id: string;
  name: string;
  plan: string;
  planName: string;
  priceCents: number;
  billingMode: 'MANUAL' | 'COMPLIMENTARY';
  paidUntil: string | null;
  trialEndsAt: string | null;
  access: Access;
  owner: { id: string; name: string; email: string; lastLoginAt: string | null } | null;
  members: number;
  clients: number;
  createdAt: string;
}
interface CustomerDetail {
  id: string;
  name: string;
  plan: string;
  billingMode: 'MANUAL' | 'COMPLIMENTARY';
  customPriceCents: number | null;
  priceCents: number;
  currency: string;
  billingEmail: string | null;
  billingNotes: string | null;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  paidUntil: string | null;
  suspendedAt: string | null;
  suspendReason: string | null;
  access: Access;
  limits: Record<string, number>;
  usage: Record<string, number>;
  members: { id: string; name: string; email: string; role: string; lastLoginAt: string | null }[];
  payments: { id: string; amountCents: number; currency: string; method: string; reference: string | null; periodStart: string; periodEnd: string; createdAt: string }[];
}
interface Plan { plan: string; name: string; priceCents: number }

/** Money typed as "29" or "29.99" → cents; null when empty or invalid. */
const toCents = (v: string) => {
  const n = Number(v.replace(',', '.'));
  return v.trim() === '' || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 100);
};
const toDateInput = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => toast.success('Copied'), () => toast.error('Copy failed; select the text instead'));
}

export function CustomersPanel() {
  const q = useQuery({ queryKey: ['admin', 'customers'], queryFn: () => api<{ currency: string; customers: CustomerRow[] }>('/admin/customers') });
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api<Plan[]>('/admin/plans') });
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.customers ?? []).filter((c) => !s || c.name.toLowerCase().includes(s) || c.owner?.email.toLowerCase().includes(s));
  }, [q.data, search]);
  const mrr = (q.data?.customers ?? []).filter((c) => c.access.state === 'active' || c.access.state === 'grace').reduce((sum, c) => sum + c.priceCents, 0);
  const due = (q.data?.customers ?? []).filter((c) => c.access.state === 'grace' || c.access.state === 'blocked').length;

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const currency = q.data!.currency;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Panel className="px-5 py-4"><p className="text-xs text-ink-3">Customers</p><p className="text-2xl font-semibold tabular-nums">{q.data!.customers.length}</p></Panel>
        <Panel className="px-5 py-4"><p className="text-xs text-ink-3">Monthly revenue (paying customers)</p><p className="text-2xl font-semibold tabular-nums">{money(mrr, currency)}</p></Panel>
        <Panel className="px-5 py-4"><p className="text-xs text-ink-3">Payment due or blocked</p><p className="text-2xl font-semibold tabular-nums">{due}</p></Panel>
      </div>
      <Panel>
        <PanelHeader
          title="Customers"
          description="Each customer is a separate organization with its own users, clients and data."
          actions={
            <div className="flex gap-2">
              <Input aria-label="Search customers" placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
              <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New customer</Button>
            </div>
          }
        />
        {rows.length === 0 ? (
          <EmptyState title={search ? 'No customer matches' : 'No customers yet'} description={search ? undefined : 'Create a customer to get an owner login you can hand over.'} />
        ) : (
          <Table>
            <thead><tr><Th>Customer</Th><Th>Plan</Th><Th className="text-right">Price</Th><Th>Status</Th><Th>Paid until</Th><Th className="text-right">Clients</Th><Th /></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-ink-3">{c.owner ? `${c.owner.email}, ${c.owner.lastLoginAt ? `signed in ${ago(c.owner.lastLoginAt)}` : 'never signed in'}` : 'No owner'}</p>
                  </Td>
                  <Td>{c.planName}{c.billingMode === 'COMPLIMENTARY' && <Badge className="ml-2">Complimentary</Badge>}</Td>
                  <Td className="text-right tabular-nums">{c.priceCents ? money(c.priceCents, currency) : 'Free'}</Td>
                  <Td><AccessBadge access={c.access} /></Td>
                  <Td className="text-ink-2">{c.paidUntil ? when(c.paidUntil) : '—'}</Td>
                  <Td className="text-right tabular-nums">{c.clients}</Td>
                  <Td className="text-right"><Button variant="secondary" size="sm" onClick={() => setOpenId(c.id)}>Manage</Button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {creating && <CreateCustomer plans={plans.data ?? []} currency={currency} onClose={() => setCreating(false)} onCreated={(id) => setOpenId(id)} />}
      {openId && <ManageCustomer id={openId} plans={plans.data ?? []} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function CreateCustomer({ plans, currency, onClose, onCreated }: { plans: Plan[]; currency: string; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ organizationName: '', plan: 'STARTER', billingMode: 'MANUAL' as 'MANUAL' | 'COMPLIMENTARY', customPrice: '', trialDays: '14', ownerName: '', ownerEmail: '', password: '' });
  const [result, setResult] = useState<{ id: string; email: string; password: string | null; existing: boolean } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<{ organization: { id: string }; owner: { email: string; password: string | null; existingAccount: boolean } }>('/admin/customers', {
        body: {
          organizationName: f.organizationName,
          plan: f.plan,
          billingMode: f.billingMode,
          customPriceCents: toCents(f.customPrice),
          trialDays: f.billingMode === 'COMPLIMENTARY' ? 0 : Number(f.trialDays || 0),
          owner: { name: f.ownerName, email: f.ownerEmail, ...(f.password ? { password: f.password } : {}) },
        },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['admin', 'customers'] });
      setResult({ id: r.organization.id, email: r.owner.email, password: r.owner.password, existing: r.owner.existingAccount });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const loginUrl = typeof window !== 'undefined' ? `${window.location.origin}/login` : '/login';
  const planPrice = plans.find((p) => p.plan === f.plan)?.priceCents ?? 0;

  if (result) {
    const handover = `Your SocialPilot account is ready.\nSign in: ${loginUrl}\nEmail: ${result.email}${result.password ? `\nPassword: ${result.password}\nPlease change your password after signing in (Settings → Your account).` : '\nUse your existing password.'}`;
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} title="Customer created" footer={<><Button variant="secondary" onClick={() => { onClose(); onCreated(result.id); }}>Manage billing</Button><Button onClick={onClose}>Done</Button></>}>
        <div className="space-y-3 text-sm">
          {result.password ? (
            <p>Send these details to the customer. <strong>The password is shown only now.</strong></p>
          ) : (
            <p>{result.email} already had an account, so they were added as owner and keep their current password.</p>
          )}
          <pre className="whitespace-pre-wrap rounded-[var(--radius-control)] border border-line bg-surface-2 p-3 text-sm">{handover}</pre>
          <Button variant="secondary" size="sm" onClick={() => copy(handover)}><Copy className="h-4 w-4" /> Copy details</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="New customer" description="Creates the organization and its owner login." wide footer={<Button loading={create.isPending} disabled={!f.organizationName || !f.ownerName || !f.ownerEmail} onClick={() => create.mutate()}>Create customer</Button>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Business or agency name" htmlFor="c-name"><Input id="c-name" value={f.organizationName} onChange={(e) => setF({ ...f, organizationName: e.target.value })} /></Field>
        <Field label="Plan" htmlFor="c-plan">
          <Select id="c-plan" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>
            {PLANS.map((p) => { const pl = plans.find((x) => x.plan === p); return <option key={p} value={p}>{pl?.name ?? humanize(p)}{pl ? ` (${pl.priceCents ? money(pl.priceCents, currency) : 'free'})` : ''}</option>; })}
          </Select>
        </Field>
        <Field label="Billing" htmlFor="c-mode" hint={f.billingMode === 'COMPLIMENTARY' ? 'Never charged or blocked for payment.' : 'You record payments as they arrive.'}>
          <Select id="c-mode" value={f.billingMode} onChange={(e) => setF({ ...f, billingMode: e.target.value as 'MANUAL' | 'COMPLIMENTARY' })}>
            <option value="MANUAL">Paid (manual payments)</option>
            <option value="COMPLIMENTARY">Complimentary</option>
          </Select>
        </Field>
        {f.billingMode === 'MANUAL' && (
          <>
            <Field label={`Custom monthly price (${currency})`} htmlFor="c-price" hint={`Leave empty for the plan price: ${planPrice ? money(planPrice, currency) : 'free'}.`}><Input id="c-price" inputMode="decimal" value={f.customPrice} onChange={(e) => setF({ ...f, customPrice: e.target.value })} /></Field>
            <Field label="Free trial (days)" htmlFor="c-trial" hint="0 = pay from today (7-day grace applies)."><Input id="c-trial" type="number" min={0} max={365} value={f.trialDays} onChange={(e) => setF({ ...f, trialDays: e.target.value })} /></Field>
          </>
        )}
        <div className="sm:col-span-2 border-t border-line pt-4 text-sm font-medium">Owner login</div>
        <Field label="Owner name" htmlFor="c-owner"><Input id="c-owner" value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
        <Field label="Owner email" htmlFor="c-email"><Input id="c-email" type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
        <Field label="Password" htmlFor="c-pass" hint="Leave empty to generate a strong one. At least 10 characters."><Input id="c-pass" type="text" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function ManageCustomer({ id, plans, onClose }: { id: string; plans: Plan[]; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'customer', id], queryFn: () => api<CustomerDetail>(`/admin/customers/${id}`) });
  const refresh = (d: CustomerDetail) => {
    qc.setQueryData(['admin', 'customer', id], d);
    qc.invalidateQueries({ queryKey: ['admin', 'customers'] });
  };
  const update = useMutation({
    mutationFn: (body: object) => api<CustomerDetail>(`/admin/customers/${id}`, { method: 'PATCH', body }),
    onSuccess: (d) => { refresh(d); toast.success('Saved'); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={q.data?.name ?? 'Customer'} wide>
      {q.isLoading ? <Skeleton className="h-64" /> : q.error ? <ErrorState error={q.error} /> : <CustomerForm key={q.data!.id + (q.data!.paidUntil ?? '')} c={q.data!} plans={plans} saving={update.isPending} onSave={(body) => update.mutate(body)} onChanged={refresh} />}
    </Drawer>
  );
}

function CustomerForm({ c, plans, saving, onSave, onChanged }: { c: CustomerDetail; plans: Plan[]; saving: boolean; onSave: (body: object) => void; onChanged: (d: CustomerDetail) => void }) {
  const [f, setF] = useState({
    plan: c.plan,
    billingMode: c.billingMode,
    customPrice: c.customPriceCents !== null ? String(c.customPriceCents / 100) : '',
    trialEndsAt: toDateInput(c.trialEndsAt),
    paidUntil: toDateInput(c.paidUntil),
    billingEmail: c.billingEmail ?? '',
    billingNotes: c.billingNotes ?? '',
  });
  const [pay, setPay] = useState({ amount: String(c.priceCents / 100), months: '1', method: 'bank_transfer', reference: '' });
  const [suspendReason, setSuspendReason] = useState('');
  const [newPassword, setNewPassword] = useState<{ email: string; password: string } | null>(null);

  const recordPayment = useMutation({
    mutationFn: () => api<CustomerDetail>(`/admin/customers/${c.id}/payments`, { body: { amountCents: toCents(pay.amount) ?? 0, months: Number(pay.months), method: pay.method, reference: pay.reference || null } }),
    onSuccess: (d) => { onChanged(d); toast.success(`Payment recorded. Paid until ${when(d.paidUntil!)}`); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const save = () =>
    onSave({
      plan: f.plan,
      billingMode: f.billingMode,
      customPriceCents: toCents(f.customPrice),
      trialEndsAt: f.trialEndsAt ? new Date(`${f.trialEndsAt}T23:59:59`).toISOString() : null,
      paidUntil: f.paidUntil ? new Date(`${f.paidUntil}T23:59:59`).toISOString() : null,
      billingEmail: f.billingEmail || null,
      billingNotes: f.billingNotes || null,
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <AccessBadge access={c.access} />
        <span className="text-sm text-ink-2">{c.priceCents ? `${money(c.priceCents, c.currency)} / month` : 'Free'}</span>
      </div>
      {c.access.state === 'blocked' && <p className="text-sm text-alert">{c.access.message}</p>}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Record a payment</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={`Amount (${c.currency})`} htmlFor="p-amount"><Input id="p-amount" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
          <Field label="Months" htmlFor="p-months"><Input id="p-months" type="number" min={1} max={36} value={pay.months} onChange={(e) => setPay({ ...pay, months: e.target.value, amount: String(((c.priceCents / 100) * Number(e.target.value || 1)).toFixed(c.priceCents % 100 ? 2 : 0)) })} /></Field>
          <Field label="Method" htmlFor="p-method"><Select id="p-method" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{humanize(m)}</option>)}</Select></Field>
          <Field label="Reference" htmlFor="p-ref"><Input id="p-ref" placeholder="Invoice or transfer ID" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
        </div>
        <p className="text-xs text-ink-3">Extends paid-until by the months paid, counted from {c.paidUntil && new Date(c.paidUntil) > new Date() ? when(c.paidUntil) : 'today'}.</p>
        <Button loading={recordPayment.isPending} disabled={toCents(pay.amount) === null} onClick={() => recordPayment.mutate()}>Record payment</Button>
      </section>

      <section className="space-y-3 border-t border-line pt-5">
        <h3 className="text-sm font-semibold">Plan and billing</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Plan" htmlFor="m-plan"><Select id="m-plan" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>{PLANS.map((p) => <option key={p} value={p}>{plans.find((x) => x.plan === p)?.name ?? humanize(p)}</option>)}</Select></Field>
          <Field label="Billing" htmlFor="m-mode"><Select id="m-mode" value={f.billingMode} onChange={(e) => setF({ ...f, billingMode: e.target.value as 'MANUAL' | 'COMPLIMENTARY' })}><option value="MANUAL">Paid (manual payments)</option><option value="COMPLIMENTARY">Complimentary</option></Select></Field>
          <Field label={`Custom monthly price (${c.currency})`} htmlFor="m-price" hint="Empty = plan price."><Input id="m-price" inputMode="decimal" value={f.customPrice} onChange={(e) => setF({ ...f, customPrice: e.target.value })} /></Field>
          <Field label="Billing email" htmlFor="m-email"><Input id="m-email" type="email" value={f.billingEmail} onChange={(e) => setF({ ...f, billingEmail: e.target.value })} /></Field>
          <Field label="Trial ends" htmlFor="m-trial"><Input id="m-trial" type="date" value={f.trialEndsAt} onChange={(e) => setF({ ...f, trialEndsAt: e.target.value })} /></Field>
          <Field label="Paid until" htmlFor="m-paid" hint="Set directly only to correct mistakes; recording a payment updates it."><Input id="m-paid" type="date" value={f.paidUntil} onChange={(e) => setF({ ...f, paidUntil: e.target.value })} /></Field>
        </div>
        <Field label="Private notes" htmlFor="m-notes"><Textarea id="m-notes" rows={2} value={f.billingNotes} onChange={(e) => setF({ ...f, billingNotes: e.target.value })} /></Field>
        <Button variant="secondary" loading={saving} onClick={save}>Save changes</Button>
      </section>

      <section className="space-y-3 border-t border-line pt-5">
        <h3 className="text-sm font-semibold">Users</h3>
        <Table>
          <tbody>
            {c.members.map((m) => (
              <tr key={m.id}>
                <Td><p className="font-medium">{m.name}</p><p className="text-xs text-ink-3">{m.email}</p></Td>
                <Td><Badge>{humanize(m.role)}</Badge></Td>
                <Td className="text-right">
                  <ConfirmButton variant="secondary" title={`Reset password for ${m.email}?`} description="A new password is generated and they're signed out everywhere. You'll see the new password once." confirmLabel="Reset password"
                    onConfirm={async () => setNewPassword(await api<{ email: string; password: string }>(`/admin/users/${m.id}/reset-password`, { body: {} }))}>
                    Reset password
                  </ConfirmButton>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {newPassword && (
          <div className="space-y-2 rounded-[var(--radius-control)] border border-line bg-surface-2 p-3 text-sm">
            <p>New password for {newPassword.email} (shown once):</p>
            <div className="flex items-center gap-2"><code className="text-base">{newPassword.password}</code><Button variant="ghost" size="sm" onClick={() => copy(newPassword.password)}><Copy className="h-4 w-4" /> Copy</Button></div>
          </div>
        )}
      </section>

      {c.payments.length > 0 && (
        <section className="space-y-3 border-t border-line pt-5">
          <h3 className="text-sm font-semibold">Payments</h3>
          <Table>
            <thead><tr><Th>Received</Th><Th>Amount</Th><Th>Method</Th><Th>Covers</Th></tr></thead>
            <tbody>{c.payments.map((p) => <tr key={p.id}><Td>{when(p.createdAt)}</Td><Td className="tabular-nums">{money(p.amountCents, p.currency)}</Td><Td>{humanize(p.method)}{p.reference ? `, ${p.reference}` : ''}</Td><Td className="text-ink-2">to {when(p.periodEnd)}</Td></tr>)}</tbody>
          </Table>
        </section>
      )}

      <section className="space-y-3 border-t border-line pt-5">
        <h3 className="text-sm font-semibold">Suspend</h3>
        {c.suspendedAt ? (
          <>
            <p className="text-sm text-ink-2">Suspended {ago(c.suspendedAt)}{c.suspendReason ? `: ${c.suspendReason}` : ''}. Users see why and can't use the app.</p>
            <Button variant="secondary" loading={saving} onClick={() => onSave({ suspended: false })}>Restore access</Button>
          </>
        ) : (
          <>
            <Field label="Reason shown to the customer" htmlFor="s-reason"><Input id="s-reason" placeholder="e.g. Payment not received" value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} /></Field>
            <ConfirmButton title={`Suspend ${c.name}?`} description="All their users lose access immediately. Scheduled posts wait and no AI replies are drafted until you restore access." confirmLabel="Suspend" onConfirm={async () => onSave({ suspended: true, suspendReason: suspendReason || null })}>
              Suspend customer
            </ConfirmButton>
          </>
        )}
      </section>
    </div>
  );
}

/** Platform-wide billing settings and plan prices. */
export function PlansPanel() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api<{ currency: string; graceDays: number; trialDays: number; allowPublicSignup: boolean; paymentInstructions: string | null }>('/admin/settings') });
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api<(Plan & { description: string | null; public: boolean; limits: Record<string, number> })[]>('/admin/plans') });
  if (settings.isLoading || plans.isLoading) return <Skeleton className="h-64" />;
  if (settings.error || plans.error) return <ErrorState error={settings.error ?? plans.error} />;
  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_2fr]">
      <PlatformSettingsForm initial={settings.data!} onSaved={() => { qc.invalidateQueries({ queryKey: ['admin'] }); }} />
      <Panel>
        <PanelHeader title="Plans" description="Prices are per month. Changing a price applies to every customer on that plan without a custom price." />
        <div className="divide-y divide-line">
          {plans.data!.map((p) => <PlanRow key={p.plan} plan={p} currency={settings.data!.currency} />)}
        </div>
      </Panel>
    </div>
  );
}

function PlatformSettingsForm({ initial, onSaved }: { initial: { currency: string; graceDays: number; trialDays: number; allowPublicSignup: boolean; paymentInstructions: string | null }; onSaved: () => void }) {
  const [f, setF] = useState({ ...initial, graceDays: String(initial.graceDays), trialDays: String(initial.trialDays), paymentInstructions: initial.paymentInstructions ?? '' });
  const save = useMutation({
    mutationFn: () => api('/admin/settings', { method: 'PUT', body: { currency: f.currency, graceDays: Number(f.graceDays), trialDays: Number(f.trialDays), allowPublicSignup: f.allowPublicSignup, paymentInstructions: f.paymentInstructions || null } }),
    onSuccess: () => { toast.success('Settings saved'); onSaved(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Panel>
      <PanelHeader title="Billing settings" />
      <div className="space-y-4 p-5">
        <Field label="Currency" htmlFor="s-cur" hint="Three-letter code, e.g. USD, EUR, INR, NPR, GBP."><Input id="s-cur" maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Free trial (days)" htmlFor="s-trial" hint="Default for new customers."><Input id="s-trial" type="number" min={0} max={365} value={f.trialDays} onChange={(e) => setF({ ...f, trialDays: e.target.value })} /></Field>
          <Field label="Grace period (days)" htmlFor="s-grace" hint="Access after paid-until."><Input id="s-grace" type="number" min={0} max={90} value={f.graceDays} onChange={(e) => setF({ ...f, graceDays: e.target.value })} /></Field>
        </div>
        <Field label="How customers pay you" htmlFor="s-instr" hint="Shown on each customer's billing page, e.g. bank details or a payment link."><Textarea id="s-instr" rows={4} value={f.paymentInstructions} onChange={(e) => setF({ ...f, paymentInstructions: e.target.value })} /></Field>
        <div className="flex items-start gap-3">
          <Switch checked={f.allowPublicSignup} onChange={(v) => setF({ ...f, allowPublicSignup: v })} label="Public sign-up" />
          <div className="text-sm">
            <p className="font-medium">Public sign-up {f.allowPublicSignup ? 'on' : 'off'}</p>
            <p className="text-ink-3">{f.allowPublicSignup ? 'Anyone can create an account on the Free plan.' : 'Only you create customer accounts.'}</p>
          </div>
        </div>
        <Button loading={save.isPending} disabled={f.currency.length !== 3} onClick={() => save.mutate()}>Save settings</Button>
      </div>
    </Panel>
  );
}

const limitText = (n: number | undefined, label: string) => `${(n ?? 0) >= 100_000 ? 'unlimited' : (n ?? 0).toLocaleString()} ${n === 1 ? label.replace(/s\b/, '') : label}`;

const LIMIT_LABELS: [string, string][] = [['clients', 'Clients'], ['socialAccounts', 'Social accounts'], ['members', 'Team members'], ['aiGenerations', 'AI generations / month'], ['posts', 'Posts / month'], ['messages', 'Messages / month']];

function PlanRow({ plan, currency }: { plan: Plan & { description: string | null; public: boolean; limits: Record<string, number> }; currency: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: plan.name, description: plan.description ?? '', price: String(plan.priceCents / 100), limits: Object.fromEntries(LIMIT_LABELS.map(([k]) => [k, String(plan.limits[k] ?? 0)])) as Record<string, string> });
  const save = useMutation({
    mutationFn: () => api(`/admin/plans/${plan.plan}`, { method: 'PUT', body: { name: f.name, description: f.description || null, priceCents: toCents(f.price) ?? 0, limits: Object.fromEntries(Object.entries(f.limits).map(([k, v]) => [k, Math.max(0, Math.round(Number(v) || 0))])) } }),
    onSuccess: () => { toast.success(`${f.name} saved`); qc.invalidateQueries({ queryKey: ['admin'] }); setOpen(false); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{plan.name} <span className="ml-1 font-normal tabular-nums text-ink-2">{plan.priceCents ? `${money(plan.priceCents, currency)} / month` : 'Free'}</span></p>
          <p className="text-xs text-ink-3">{limitText(plan.limits.clients, 'clients')}, {limitText(plan.limits.socialAccounts, 'social accounts')}, {limitText(plan.limits.aiGenerations, 'AI generations a month')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Edit'}</Button>
      </div>
      {open && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Name" htmlFor={`pl-${plan.plan}-name`}><Input id={`pl-${plan.plan}-name`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label={`Price per month (${currency})`} htmlFor={`pl-${plan.plan}-price`}><Input id={`pl-${plan.plan}-price`} inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
            <Field label="Description" htmlFor={`pl-${plan.plan}-desc`}><Input id={`pl-${plan.plan}-desc`} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {LIMIT_LABELS.map(([k, label]) => (
              <Field key={k} label={label} htmlFor={`pl-${plan.plan}-${k}`}><Input id={`pl-${plan.plan}-${k}`} type="number" min={0} value={f.limits[k]} onChange={(e) => setF({ ...f, limits: { ...f.limits, [k]: e.target.value } })} /></Field>
            ))}
          </div>
          <Button loading={save.isPending} disabled={toCents(f.price) === null} onClick={() => save.mutate()}>Save plan</Button>
        </div>
      )}
    </div>
  );
}
