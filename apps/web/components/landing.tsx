'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { money } from './billing';
import { api } from '@/lib/api';

interface PublicPlan { plan: string; name: string; description: string | null; priceCents: number; limits: Record<string, number> }

/** A day on the board: real events from the product, in the order they'd happen. */
const BOARD = [
  { tone: 'strip-sky', time: '08:02', title: 'Drafted 3 platform versions of “Autumn menu”', meta: "Bella's Bakery, written by Muse Spark" },
  { tone: 'strip-runway', time: '08:40', title: 'Waiting for client approval', meta: "Bella's Bakery, due 12:00" },
  { tone: 'strip-clearance', time: '09:00', title: 'Published to Instagram and Facebook', meta: "Bella's Bakery" },
  { tone: 'strip-sky', time: '09:14', title: 'Reply sent: “Yes, we deliver to Kentish Town”', meta: 'Answered from the knowledge base, 94% confident' },
  { tone: 'strip-alert', time: '09:31', title: 'Refund request handed to a person', meta: 'Summit Fitness, AI replies paused for this chat' },
  { tone: 'strip-clearance', time: '10:05', title: 'New lead: wedding cake for 80 guests', meta: 'Website form, follow-up set for Friday' },
];

const FLOW = [
  { title: 'Draft', body: 'Muse Spark writes a version of each post for every platform, in the client’s voice, from a one-line idea.' },
  { title: 'Approve', body: 'The client or your approver signs off in the app. Nothing is published without it when approval is required.' },
  { title: 'Publish', body: 'Posts go out on schedule through each platform’s official API, with retries and no duplicates.' },
  { title: 'Answer', body: 'Comments and DMs land in one inbox. The AI drafts a reply from the client’s own facts and decides: send, hold for review, or hand to a person.' },
  { title: 'Capture', body: 'Buying intent in a chat, a website form or another tool becomes a lead in the CRM, with a follow-up reminder.' },
];

const FEATURES: [string, string][] = [
  ['Every client in one place', 'Agencies manage many client workspaces, each with its own accounts, brand voice, knowledge and team access.'],
  ['Replies you can trust', 'Confidence thresholds, safety rules and prompt-injection defences decide what the AI may send on its own.'],
  ['Leads from anywhere', 'Embeddable website forms, a lead API for Zapier or Make, and signed webhooks out to other systems.'],
  ['Approval that fits the client', 'Per-client rules: require sign-off, auto-reply hours, escalation keywords, tone.'],
  ['Honest analytics', 'Platform metrics stored as history and summarised by AI. Numbers a platform doesn’t provide are shown as unavailable, never guessed.'],
  ['Built to sell', 'Plans, trials, payments, customer accounts and a platform console for running it as your own SaaS.'],
];

export function Landing() {
  const me = useQuery({ queryKey: ['me-landing'], queryFn: () => api<{ user: { name: string } }>('/auth/me'), retry: false });
  const plans = useQuery({ queryKey: ['public-plans'], queryFn: () => api<{ currency: string; allowPublicSignup: boolean; plans: PublicPlan[] }>('/public/plans'), retry: false });
  const signedIn = Boolean(me.data);
  const signup = plans.data?.allowPublicSignup !== false;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="bg-rail">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6" aria-label="Main">
          <span className="text-lg font-semibold text-white">SocialPilot</span>
          <div className="flex items-center gap-2 text-sm">
            <a href="#how" className="hidden px-3 py-2 text-rail-ink hover:text-white sm:inline">How it works</a>
            {plans.data?.plans.length ? <a href="#pricing" className="hidden px-3 py-2 text-rail-ink hover:text-white sm:inline">Pricing</a> : null}
            {signedIn ? (
              <Link href="/dashboard" className="rounded-[var(--radius-control)] bg-clearance px-4 py-2 font-medium text-clearance-ink">Open dashboard</Link>
            ) : (
              <>
                <Link href="/login" className="px-3 py-2 text-rail-ink hover:text-white">Sign in</Link>
                {signup && <Link href="/register" className="rounded-[var(--radius-control)] bg-clearance px-4 py-2 font-medium text-clearance-ink">Start free</Link>}
              </>
            )}
          </div>
        </nav>

        <section className="mx-auto grid max-w-6xl gap-12 px-4 pb-20 pt-10 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:pb-28 lg:pt-16">
          <div className="self-center">
            <h1 className="max-w-xl text-4xl font-semibold leading-[1.1] text-white sm:text-5xl">Every client’s social media, run from one board.</h1>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-rail-ink">
              SocialPilot drafts the posts, gets them approved, publishes on time, answers comments and messages, and turns interest into leads. The AI does the first draft; your team stays in charge.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {signedIn ? (
                <Link href="/dashboard" className="rounded-[var(--radius-control)] bg-clearance px-5 py-3 font-medium text-clearance-ink">Open dashboard</Link>
              ) : (
                <>
                  {signup && <Link href="/register" className="rounded-[var(--radius-control)] bg-clearance px-5 py-3 font-medium text-clearance-ink">Start free</Link>}
                  <Link href="/login" className="rounded-[var(--radius-control)] border border-rail-active px-5 py-3 font-medium text-white hover:bg-rail-active">Sign in</Link>
                </>
              )}
            </div>
            <p className="mt-6 text-sm text-rail-ink">Runs on Meta’s Muse Spark models. Connects to Facebook, Instagram, WhatsApp, LinkedIn and TikTok through their official APIs.</p>
          </div>

          <figure aria-label="Example day on the board" className="rounded-[var(--radius-panel)] border border-rail-active bg-[#0f1a31] p-4 sm:p-5">
            <figcaption className="mb-3 flex items-center justify-between text-xs text-rail-ink">
              <span>Today, across 3 clients</span>
              <span className="tabular-nums">6 events</span>
            </figcaption>
            <ol className="space-y-2">
              {BOARD.map((b) => (
                <li key={b.time} className={`strip ${b.tone} flex gap-4 rounded-r-md bg-rail-active px-4 py-3`}>
                  <span className="w-11 shrink-0 pt-0.5 text-xs tabular-nums text-rail-ink">{b.time}</span>
                  <span className="min-w-0">
                    <span className="block text-sm text-white">{b.title}</span>
                    <span className="block text-xs text-rail-ink">{b.meta}</span>
                  </span>
                </li>
              ))}
            </ol>
          </figure>
        </section>
      </header>

      <main>
        <section id="how" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="max-w-2xl text-3xl font-semibold">From an idea to a published post and a qualified lead</h2>
          <ol className="mt-10 grid gap-8 md:grid-cols-5">
            {FLOW.map((step, i) => (
              <li key={step.title} className="border-t-2 border-clearance pt-4">
                <span className="text-sm tabular-nums text-ink-3">{i + 1}</span>
                <h3 className="mt-1 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-y border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <h2 className="text-3xl font-semibold">Meta’s models, on Meta’s platforms</h2>
              <p className="mt-4 leading-relaxed text-ink-2">
                Every AI step runs on Muse Spark through the Meta Model API: writing posts, reading intent in messages, drafting grounded replies, pulling lead details and summarising results. Quick classification steps ask for minimal reasoning to keep costs low; backup providers take over automatically if a model is busy.
              </p>
            </div>
            <dl className="grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2">
              {[
                ['Post writing', 'One version per platform, in the brand’s voice, with hashtags and a call to action.'],
                ['Inbox triage', 'Question, complaint, lead or spam, decided for every comment and DM.'],
                ['Grounded replies', 'Answers only from the client’s knowledge base, with a confidence score.'],
                ['Lead extraction', 'Name, need and contact details pulled from the conversation into the CRM.'],
              ].map(([t, d]) => (
                <div key={t} className="bg-surface p-5">
                  <dt className="font-semibold">{t}</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-ink-2">{d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="text-3xl font-semibold">Made for agencies that answer to clients</h2>
          <dl className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(([t, d]) => (
              <div key={t}>
                <dt className="font-semibold">{t}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-ink-2">{d}</dd>
              </div>
            ))}
          </dl>
        </section>

        {plans.data && plans.data.plans.length > 0 && (
          <section id="pricing" className="border-t border-line bg-surface">
            <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
              <h2 className="text-3xl font-semibold">Pricing</h2>
              <p className="mt-2 text-ink-2">Monthly, per agency. Change or cancel any time.</p>
              <div className="mt-10 overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th scope="col" className="py-3 pr-4 font-medium text-ink-3">Plan</th>
                      <th scope="col" className="py-3 pr-4 font-medium text-ink-3">Price</th>
                      <th scope="col" className="py-3 pr-4 font-medium text-ink-3">Clients</th>
                      <th scope="col" className="py-3 pr-4 font-medium text-ink-3">Social accounts</th>
                      <th scope="col" className="py-3 pr-4 font-medium text-ink-3">Team</th>
                      <th scope="col" className="py-3 font-medium text-ink-3">AI generations / month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.data.plans.map((p) => {
                      const n = (k: string) => ((p.limits[k] ?? 0) >= 100_000 ? 'Unlimited' : (p.limits[k] ?? 0).toLocaleString());
                      return (
                        <tr key={p.plan} className="border-b border-line">
                          <th scope="row" className="py-4 pr-4">
                            <span className="font-semibold">{p.name}</span>
                            {p.description && <span className="block text-xs font-normal text-ink-3">{p.description}</span>}
                          </th>
                          <td className="py-4 pr-4 tabular-nums">{p.priceCents ? money(p.priceCents, plans.data!.currency) : 'Free'}</td>
                          <td className="py-4 pr-4 tabular-nums">{n('clients')}</td>
                          <td className="py-4 pr-4 tabular-nums">{n('socialAccounts')}</td>
                          <td className="py-4 pr-4 tabular-nums">{n('members')}</td>
                          <td className="py-4 tabular-nums">{n('aiGenerations')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        <section className="bg-rail">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-4 py-16 sm:px-6 md:flex-row md:items-center">
            <h2 className="max-w-xl text-2xl font-semibold text-white">Put tomorrow’s posts, replies and leads on one board.</h2>
            {signedIn ? (
              <Link href="/dashboard" className="rounded-[var(--radius-control)] bg-clearance px-5 py-3 font-medium text-clearance-ink">Open dashboard</Link>
            ) : signup ? (
              <Link href="/register" className="rounded-[var(--radius-control)] bg-clearance px-5 py-3 font-medium text-clearance-ink">Start free</Link>
            ) : (
              <Link href="/login" className="rounded-[var(--radius-control)] bg-clearance px-5 py-3 font-medium text-clearance-ink">Sign in</Link>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-ink-3 sm:px-6">
          <span>SocialPilot</span>
          <nav className="flex gap-5" aria-label="Legal">
            <Link href="/terms" className="hover:text-ink">Terms</Link>
            <Link href="/privacy" className="hover:text-ink">Privacy</Link>
            <Link href="/login" className="hover:text-ink">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
