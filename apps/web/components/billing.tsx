'use client';

import { useQuery } from '@tanstack/react-query';
import { LockKeyhole } from 'lucide-react';
import { humanize, when } from './domain';
import { Badge, Button, ErrorState, Panel, PanelHeader, Skeleton, Table, Td, Th } from './ui/primitives';
import { api } from '@/lib/api';

export type Access =
  | { state: 'active' }
  | { state: 'trial'; endsAt: string | null }
  | { state: 'grace'; blockAt: string }
  | { state: 'blocked'; reason: 'suspended' | 'canceled' | 'trial_ended' | 'overdue'; message: string };

export function money(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Whole days from now until a date (negative when past). */
export const daysUntil = (d: string | Date) => Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);

export function AccessBadge({ access }: { access: Access }) {
  switch (access.state) {
    case 'active':
      return <Badge tone="clearance">Active</Badge>;
    case 'trial':
      return <Badge tone="sky">{access.endsAt ? `Trial, ${Math.max(0, daysUntil(access.endsAt))} days left` : 'Trial'}</Badge>;
    case 'grace':
      return <Badge tone="runway">Payment due, blocks in {Math.max(0, daysUntil(access.blockAt))} days</Badge>;
    case 'blocked':
      return <Badge tone="alert">{access.reason === 'trial_ended' ? 'Trial ended' : humanize(access.reason)}</Badge>;
  }
}

interface Billing {
  plan: { key: string; name: string; description: string | null };
  priceCents: number;
  currency: string;
  billingMode: 'MANUAL' | 'COMPLIMENTARY';
  subscriptionStatus: string;
  trialEndsAt: string | null;
  paidUntil: string | null;
  access: Access;
  paymentInstructions: string | null;
  limits: Record<string, number>;
  usage: Record<string, number>;
  payments: { id: string; amountCents: number; currency: string; method: string; periodStart: string; periodEnd: string; createdAt: string }[];
}

const USAGE_ROWS: [string, string][] = [['clients', 'Clients'], ['socialAccounts', 'Social accounts'], ['members', 'Team members'], ['aiGenerations', 'AI generations this month'], ['posts', 'Posts this month'], ['messages', 'Messages this month']];

/** The customer's own plan, dates, usage and payment history. */
export function BillingPanel() {
  const q = useQuery({ queryKey: ['billing'], queryFn: () => api<Billing>('/billing') });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const b = q.data!;
  const unlimited = (n: number) => n >= 100_000;
  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
      <Panel>
        <PanelHeader title="Your plan" actions={<AccessBadge access={b.access} />} />
        <dl className="grid grid-cols-1 gap-4 p-5 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-3">Plan</dt>
            <dd className="text-lg font-semibold">{b.plan.name}</dd>
            {b.plan.description && <dd className="text-ink-2">{b.plan.description}</dd>}
          </div>
          <div>
            <dt className="text-ink-3">Price</dt>
            <dd className="text-lg font-semibold tabular-nums">{b.billingMode === 'COMPLIMENTARY' ? 'Complimentary' : b.priceCents === 0 ? 'Free' : `${money(b.priceCents, b.currency)} / month`}</dd>
          </div>
          {b.access.state === 'trial' && b.trialEndsAt && (
            <div>
              <dt className="text-ink-3">Trial ends</dt>
              <dd>{when(b.trialEndsAt)}</dd>
            </div>
          )}
          {b.paidUntil && (
            <div>
              <dt className="text-ink-3">Paid until</dt>
              <dd>{when(b.paidUntil)}</dd>
            </div>
          )}
        </dl>
        {b.access.state === 'blocked' && <p className="border-t border-line px-5 py-3 text-sm text-alert">{b.access.message}</p>}
        {b.paymentInstructions && b.priceCents > 0 && (
          <div className="border-t border-line px-5 py-4">
            <h3 className="mb-1 text-sm font-medium">How to pay</h3>
            <p className="whitespace-pre-line text-sm text-ink-2">{b.paymentInstructions}</p>
          </div>
        )}
      </Panel>
      <Panel>
        <PanelHeader title="Usage" description="Resets on the 1st of each month for monthly items." />
        <Table>
          <tbody>
            {USAGE_ROWS.map(([k, label]) => (
              <tr key={k}>
                <Td>{label}</Td>
                <Td className="text-right tabular-nums">
                  {(b.usage[k] ?? 0).toLocaleString()} <span className="text-ink-3">/ {unlimited(b.limits[k] ?? 0) ? 'unlimited' : (b.limits[k] ?? 0).toLocaleString()}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
      {b.payments.length > 0 && (
        <Panel className="xl:col-span-2">
          <PanelHeader title="Payments" />
          <Table>
            <thead><tr><Th>Received</Th><Th>Amount</Th><Th>Method</Th><Th>Covers</Th></tr></thead>
            <tbody>
              {b.payments.map((p) => (
                <tr key={p.id}>
                  <Td>{when(p.createdAt)}</Td>
                  <Td className="tabular-nums">{money(p.amountCents, p.currency)}</Td>
                  <Td>{humanize(p.method)}</Td>
                  <Td className="text-ink-2">{when(p.periodStart)} to {when(p.periodEnd)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </div>
  );
}

/** Replaces the app for a blocked organization: why, and how to get access back. */
export function BlockedScreen({ orgName, access, canSeeBilling, onSignOut, otherOrgs }: { orgName: string; access: Extract<Access, { state: 'blocked' }>; canSeeBilling: boolean; onSignOut: () => void; otherOrgs: { id: string; name: string; onSelect: () => void }[] }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <div className="mb-6 flex items-start gap-3">
        <LockKeyhole className="mt-1 h-6 w-6 shrink-0 text-alert" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold">{orgName} is paused</h1>
          <p className="mt-1 text-ink-2">{access.message}</p>
          {!canSeeBilling && <p className="mt-1 text-sm text-ink-3">Ask your organization&apos;s owner to sort out billing.</p>}
        </div>
      </div>
      {canSeeBilling && <BillingPanel />}
      <div className="mt-6 flex flex-wrap gap-2">
        {otherOrgs.map((o) => (
          <Button key={o.id} variant="secondary" onClick={o.onSelect}>Switch to {o.name}</Button>
        ))}
        <Button variant="ghost" onClick={onSignOut}>Sign out</Button>
      </div>
    </div>
  );
}
