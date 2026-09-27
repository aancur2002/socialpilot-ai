import { createHmac, timingSafeEqual } from 'node:crypto';
import { requirePermission, type AuthContext } from '../context';
import { AppError, badRequest, forbidden } from '../errors';
import { getInfra } from '../infra';
import { getPlatformSettings, listPlans, recordPayment } from './billing.service';
import { adminUpdatePlatformGroup, getPlatformGroup } from './platform-settings.service';

/**
 * Card payments through Stripe Checkout. Off by default: the platform admin saves
 * the keys in Platform admin → Payments, runs "Check keys", and only then can
 * switch card payments on. While off, customers see the manual payment
 * instructions only and the webhook refuses events.
 * Calls the Stripe REST API directly (form-encoded), so no SDK is needed.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

/** Card payments are live only when switched on and fully configured. */
export async function stripeEnabled(): Promise<boolean> {
  const s = await getPlatformGroup('stripe');
  return Boolean(s.enabled && s.secretKey && s.webhookSecret);
}

/** Flattens {a:{b:1}} into Stripe's form encoding: a[b]=1. */
function formEncode(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? formEncode(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') formEncode(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripeRequest<T>(secretKey: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${STRIPE_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${secretKey}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), 'stripe-version': '2024-06-20' },
    body: body ? formEncode(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok) throw badRequest(`Stripe: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json;
}

/**
 * Checks the saved keys against Stripe (reads the account balance, which needs a
 * valid secret key and changes nothing). Required before card payments can be
 * switched on.
 */
export async function checkStripeKeys(user: { isSuperAdmin: boolean }, fetchImpl?: typeof fetch) {
  if (!user.isSuperAdmin) throw forbidden('Super admin only');
  const s = await getPlatformGroup('stripe');
  const missing = [!s.publishableKey && 'publishable key', !s.secretKey && 'secret key', !s.webhookSecret && 'webhook signing secret'].filter(Boolean);
  if (missing.length) throw badRequest(`Save the ${missing.join(', ')} first.`);
  if (!/^pk_(test|live)_/.test(s.publishableKey!)) throw badRequest('The publishable key should start with pk_test_ or pk_live_.');
  if (!/^(sk|rk)_(test|live)_/.test(s.secretKey!)) throw badRequest('The secret key should start with sk_test_, sk_live_ or rk_.');
  if (!/^whsec_/.test(s.webhookSecret!)) throw badRequest('The webhook signing secret should start with whsec_.');
  const liveKeys = [s.publishableKey!.includes('_live_'), s.secretKey!.includes('_live_')];
  if (liveKeys[0] !== liveKeys[1]) throw badRequest('One key is a test key and the other a live key. Use both from the same mode.');
  const balance = await stripeRequest<{ livemode: boolean }>(s.secretKey!, 'GET', '/balance', undefined, fetchImpl);
  return { ok: true, mode: balance.livemode ? 'live' : 'test' };
}

/** Switches card payments on (only after the keys pass the check) or off. */
export async function setStripeEnabled(user: { id: string; isSuperAdmin: boolean }, enabled: boolean, fetchImpl?: typeof fetch) {
  if (!user.isSuperAdmin) throw forbidden('Super admin only');
  if (enabled) await checkStripeKeys(user, fetchImpl);
  return adminUpdatePlatformGroup(user, 'stripe', { enabled });
}

/** Starts a Stripe Checkout for this organization's price × months; returns the payment page URL. */
export async function createCheckout(ctx: AuthContext, input: { months: number }, fetchImpl?: typeof fetch) {
  requirePermission(ctx, 'settings:manage');
  if (!(await stripeEnabled())) throw badRequest('Card payments are not available. Pay using the instructions on this page.');
  const stripe = await getPlatformGroup('stripe');
  const { db, env } = getInfra();
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const plan = (await listPlans()).find((p) => p.plan === org.plan)!;
  const monthly = org.billingMode === 'COMPLIMENTARY' ? 0 : (org.customPriceCents ?? plan.priceCents);
  if (monthly <= 0) throw badRequest('This plan has nothing to pay.');
  const settings = await getPlatformSettings();
  const company = await getPlatformGroup('company');
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { email: true } });
  const session = await stripeRequest<{ id: string; url: string }>(
    stripe.secretKey!,
    'POST',
    '/checkout/sessions',
    {
      mode: 'payment',
      success_url: `${env.APP_URL}/settings?tab=billing&payment=success`,
      cancel_url: `${env.APP_URL}/settings?tab=billing&payment=cancelled`,
      client_reference_id: org.id,
      customer_email: org.billingEmail ?? user.email,
      line_items: [{ quantity: 1, price_data: { currency: settings.currency.toLowerCase(), unit_amount: monthly * input.months, product_data: { name: `${company.productName} ${plan.name}: ${input.months} month${input.months === 1 ? '' : 's'}`, description: org.name } } }],
      metadata: { organizationId: org.id, months: String(input.months) },
      payment_intent_data: { metadata: { organizationId: org.id, months: String(input.months) } },
    },
    fetchImpl,
  );
  return { url: session.url };
}

/** Verifies the Stripe-Signature header (t=…,v1=…) against the raw request body. */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest();
  return parts.filter(([k]) => k === 'v1').some(([, v]) => {
    const given = Buffer.from(v ?? '', 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

interface CheckoutSession {
  id: string;
  payment_status: string;
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  payment_intent: string | null;
  metadata: Record<string, string> | null;
}

/** Stripe webhook: records paid checkouts. Idempotent on the checkout session id. */
export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
  if (!(await stripeEnabled())) throw new AppError('NOT_CONFIGURED', 'Card payments are switched off');
  const stripe = await getPlatformGroup('stripe');
  if (!verifyStripeSignature(rawBody, signature, stripe.webhookSecret!)) throw new AppError('UNAUTHENTICATED', 'Invalid Stripe signature');
  const event = JSON.parse(rawBody.toString('utf8')) as { id: string; type: string; data: { object: CheckoutSession } };
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return { received: true, ignored: event.type };
  const session = event.data.object;
  if (session.payment_status !== 'paid') return { received: true, ignored: 'not paid yet' };
  const organizationId = session.metadata?.organizationId ?? session.client_reference_id;
  const months = Number(session.metadata?.months ?? 1);
  if (!organizationId || !Number.isInteger(months) || months < 1) {
    getInfra().logger.warn({ sessionId: session.id }, 'stripe checkout without organization metadata');
    return { received: true, ignored: 'no organization' };
  }
  const result = await recordPayment(
    organizationId,
    { amountCents: session.amount_total ?? 0, months, method: 'card', reference: session.payment_intent ?? session.id, currency: (session.currency ?? 'usd').toUpperCase() },
    { provider: 'stripe', providerRef: session.id },
  );
  return { received: true, recorded: result.recorded };
}
