'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MockBadge, PlatformChip, platformName } from '@/components/domain';
import { Button, cn, Field, Input, Panel, Switch, Textarea } from '@/components/ui/primitives';
import { api, errorMessage, getCurrentOrg, setCurrentOrg } from '@/lib/api';
import type { Client, Content, CurrentOrg, Me, PlatformStatus, SocialAccount } from '@/lib/types';

const STEPS = ['Organization', 'Client', 'Brand', 'Accounts', 'AI settings', 'First post', 'Approve', 'Schedule'] as const;
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function OnboardingPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: false });
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [client, setClient] = useState<Client | null>(null);
  const [clientName, setClientName] = useState('');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [brand, setBrand] = useState({ description: '', tone: '', targetAudience: '', services: '', website: '', cta: '', preferredHashtags: '' });
  const [ai, setAi] = useState({ aiEnabled: true, autoReplyEnabled: false, humanApprovalRequired: true });
  const [topic, setTopic] = useState('');
  const [content, setContent] = useState<Content | null>(null);
  const [scheduleAt, setScheduleAt] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));

  const org = useQuery({ queryKey: ['org'], queryFn: () => api<CurrentOrg>('/organizations/current'), enabled: step > 0 && Boolean(getCurrentOrg()) });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => api<{ mockEnabled: boolean; platforms: PlatformStatus[] }>('/social/platforms'), enabled: step >= 3 });
  const accounts = useQuery({ queryKey: ['accounts', client?.id], queryFn: () => api<SocialAccount[]>('/social/accounts', { query: { clientId: client!.id } }), enabled: Boolean(client) && step >= 3 });

  useEffect(() => {
    if (!me.data) return;
    if (me.data.organizations.length) {
      if (!getCurrentOrg()) setCurrentOrg(me.data.organizations[0]!.id);
      setStep((s) => Math.max(s, 1));
      // Returning from a platform's OAuth redirect: resume at the accounts step.
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem('sp.onboardingClient');
      } catch {
        saved = null;
      }
      if (saved) {
        api<Client>(`/clients/${saved}`)
          .then((c) => {
            setClient(c);
            setStep((s) => Math.max(s, 3));
          })
          .catch(() => undefined);
      }
    }
  }, [me.data]);

  useEffect(() => {
    if (me.error) router.replace('/login');
  }, [me.error, router]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    await api('/organizations/current', { method: 'PATCH', body: { onboardingStep: null } }).catch(() => undefined);
    try {
      sessionStorage.removeItem('sp.onboardingClient');
    } catch {
      /* ignore */
    }
    qc.clear();
    router.replace('/dashboard');
  };

  return (
    <div className="min-h-screen bg-paper px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between">
          <span className="text-lg font-semibold">SocialPilot</span>
          {step > 1 && (
            <Button variant="ghost" size="sm" onClick={finish}>
              Skip setup
            </Button>
          )}
        </div>
        <ol className="mb-8 grid grid-cols-4 gap-2 sm:grid-cols-8" aria-label="Setup progress">
          {STEPS.map((label, i) => (
            <li key={label} className="text-xs">
              <div className={cn('mb-1.5 h-1 rounded-full', i < step ? 'bg-clearance' : i === step ? 'bg-runway' : 'bg-line')} />
              <span className={cn(i === step ? 'font-medium text-ink' : 'text-ink-3')}>
                {i + 1}. {label}
              </span>
            </li>
          ))}
        </ol>

        <Panel className="p-6 sm:p-8">
          {step === 0 && (
            <div className="space-y-5">
              <h1 className="text-xl font-semibold">Name your organization</h1>
              <p className="text-sm text-ink-2">This is your agency or company. You’ll add the brands you manage as clients.</p>
              <Field label="Organization name" htmlFor="org">
                <Input id="org" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Northside Digital" />
              </Field>
              <Button loading={busy} disabled={!orgName.trim()} onClick={() => run(async () => {
                const o = await api<{ id: string }>('/organizations', { body: { name: orgName } });
                setCurrentOrg(o.id);
                setStep(1);
              })}>
                Continue
              </Button>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <h1 className="text-xl font-semibold">Add your first client</h1>
              <p className="text-sm text-ink-2">Each client gets its own accounts, content, inbox and knowledge. {org.data ? `You’re setting up ${org.data.name}.` : ''}</p>
              <Field label="Client or brand name" htmlFor="cname">
                <Input id="cname" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Bella's Bakery" />
              </Field>
              <Field label="Timezone" htmlFor="tz" hint="Used for scheduling and business hours">
                <Input id="tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
              </Field>
              <Button loading={busy} disabled={!clientName.trim()} onClick={() => run(async () => {
                const created = await api<Client>('/clients', { body: { name: clientName, timezone } });
                setClient(created);
                try {
                  sessionStorage.setItem('sp.onboardingClient', created.id);
                } catch {
                  /* resume-after-redirect is a convenience only */
                }
                setStep(2);
              })}>
                Create client
              </Button>
            </div>
          )}

          {step === 2 && client && (
            <div className="space-y-4">
              <h1 className="text-xl font-semibold">Tell the AI about {client.name}</h1>
              <p className="text-sm text-ink-2">Content and replies use only what you enter here and in the knowledge base. Missing facts are flagged, never invented.</p>
              <Field label="What the business does" htmlFor="desc">
                <Textarea id="desc" value={brand.description} onChange={(e) => setBrand({ ...brand, description: e.target.value })} />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Tone of voice" htmlFor="tone">
                  <Input id="tone" value={brand.tone} onChange={(e) => setBrand({ ...brand, tone: e.target.value })} placeholder="Warm and playful" />
                </Field>
                <Field label="Target audience" htmlFor="aud">
                  <Input id="aud" value={brand.targetAudience} onChange={(e) => setBrand({ ...brand, targetAudience: e.target.value })} />
                </Field>
                <Field label="Services" htmlFor="svc" hint="Separate with commas">
                  <Input id="svc" value={brand.services} onChange={(e) => setBrand({ ...brand, services: e.target.value })} />
                </Field>
                <Field label="Website" htmlFor="web">
                  <Input id="web" value={brand.website} onChange={(e) => setBrand({ ...brand, website: e.target.value })} placeholder="https://" />
                </Field>
                <Field label="Default call to action" htmlFor="cta">
                  <Input id="cta" value={brand.cta} onChange={(e) => setBrand({ ...brand, cta: e.target.value })} />
                </Field>
                <Field label="Preferred hashtags" htmlFor="tags" hint="Separate with commas">
                  <Input id="tags" value={brand.preferredHashtags} onChange={(e) => setBrand({ ...brand, preferredHashtags: e.target.value })} />
                </Field>
              </div>
              <Button loading={busy} onClick={() => run(async () => {
                await api(`/clients/${client.id}/brand`, {
                  method: 'PUT',
                  body: { brandName: client.name, description: brand.description || null, tone: brand.tone || null, targetAudience: brand.targetAudience || null, services: list(brand.services), website: brand.website || null, cta: brand.cta || null, preferredHashtags: list(brand.preferredHashtags) },
                });
                setStep(3);
              })}>
                Save brand
              </Button>
            </div>
          )}

          {step === 3 && client && (
            <div className="space-y-4">
              <h1 className="text-xl font-semibold">Connect social accounts</h1>
              <p className="text-sm text-ink-2">Accounts connect through each platform’s official sign-in. SocialPilot never sees passwords.</p>
              <ul className="divide-y divide-line rounded-[var(--radius-panel)] border border-line">
                {platforms.data?.platforms.filter((p) => p.implemented).map((p) => {
                  const connected = accounts.data?.filter((a) => a.platform === p.platform) ?? [];
                  return (
                    <li key={p.platform} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="flex items-center gap-3">
                        <PlatformChip platform={p.platform} />
                        <div>
                          <p className="text-sm font-medium">{platformName(p.platform)}</p>
                          <p className="text-xs text-ink-3">{connected.length ? connected.map((c) => c.displayName).join(', ') : p.configured ? 'Ready to connect' : 'Needs app credentials on the server'}</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {p.configured && (
                          <Button size="sm" variant="secondary" onClick={() => run(async () => {
                            const r = await api<{ authorizationUrl: string }>('/social/oauth/start', { body: { clientId: client.id, platform: p.platform, redirectPath: '/onboarding' } });
                            window.location.assign(r.authorizationUrl);
                          })}>
                            Connect
                          </Button>
                        )}
                        {p.mockAvailable && (
                          <Button size="sm" variant="ghost" onClick={() => run(async () => {
                            await api('/social/accounts/mock', { body: { clientId: client.id, platform: p.platform } });
                            await accounts.refetch();
                          })}>
                            Add mock account
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {platforms.data?.mockEnabled && (
                <p className="flex items-center gap-2 text-xs text-ink-3">
                  <MockBadge /> Mock accounts simulate a platform for development. Nothing is posted anywhere.
                </p>
              )}
              <Button onClick={() => setStep(4)}>Continue</Button>
            </div>
          )}

          {step === 4 && client && (
            <div className="space-y-5">
              <h1 className="text-xl font-semibold">Choose how much the AI does</h1>
              <p className="text-sm text-ink-2">You can change these per client at any time.</p>
              {[
                { key: 'aiEnabled' as const, label: 'AI drafting', hint: 'Draft posts and reply suggestions with AI.' },
                { key: 'humanApprovalRequired' as const, label: 'Require approval before publishing', hint: 'Every post needs a person to approve it.' },
                { key: 'autoReplyEnabled' as const, label: 'Automatic replies', hint: 'Send confident answers to simple questions without review. Complaints, refunds and legal topics always go to a person.' },
              ].map((o) => (
                <div key={o.key} className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{o.label}</p>
                    <p className="text-sm text-ink-2">{o.hint}</p>
                  </div>
                  <Switch label={o.label} checked={ai[o.key]} onChange={(v) => setAi({ ...ai, [o.key]: v })} />
                </div>
              ))}
              <Button loading={busy} onClick={() => run(async () => {
                await api(`/clients/${client.id}/settings`, { method: 'PATCH', body: ai });
                setStep(5);
              })}>
                Save settings
              </Button>
            </div>
          )}

          {step === 5 && client && (
            <div className="space-y-4">
              <h1 className="text-xl font-semibold">Create your first post</h1>
              <p className="text-sm text-ink-2">Describe the idea. The AI writes a version for each connected platform.</p>
              <Field label="What should the post be about?" htmlFor="topic">
                <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Our new seasonal menu launches this Friday" />
              </Field>
              <Button loading={busy} disabled={!topic.trim()} onClick={() => run(async () => {
                const publishable = [...new Set((accounts.data ?? []).filter((a) => a.capabilities.publishing).map((a) => a.platform))];
                const res = await api<{ content: Content }>('/content/generate', { body: { clientId: client.id, topic, platforms: publishable.length ? publishable : ['FACEBOOK'] } });
                setContent(res.content);
                setStep(6);
              })}>
                Generate post
              </Button>
            </div>
          )}

          {step === 6 && content && (
            <div className="space-y-4">
              <h1 className="text-xl font-semibold">Review and approve</h1>
              {content.missingInfo.length > 0 && (
                <div className="rounded-[var(--radius-control)] bg-runway-soft px-3 py-2 text-sm">
                  <p className="font-medium">The AI left these out rather than guess:</p>
                  <ul className="mt-1 list-disc pl-5">{content.missingInfo.map((m) => <li key={m}>{m}</li>)}</ul>
                </div>
              )}
              {content.variants.map((v) => (
                <div key={v.id} className="rounded-[var(--radius-panel)] border border-line p-4">
                  <PlatformChip platform={v.platform} withName />
                  <p className="mt-2 whitespace-pre-wrap text-sm">{v.caption}</p>
                  {v.hashtags.length > 0 && <p className="mt-2 text-sm text-sky">{v.hashtags.map((h) => `#${h}`).join(' ')}</p>}
                </div>
              ))}
              <div className="flex gap-2">
                <Button loading={busy} onClick={() => run(async () => {
                  await api(`/content/${content.id}/submit`, { body: {} });
                  setContent(await api<Content>(`/content/${content.id}/approve`, { body: { decision: 'APPROVE' } }));
                  setStep(7);
                })}>
                  Approve post
                </Button>
                <Button variant="secondary" onClick={() => router.push(`/content/${content.id}`)}>
                  Edit first
                </Button>
              </div>
            </div>
          )}

          {step === 7 && content && (
            <div className="space-y-4">
              <h1 className="text-xl font-semibold">Schedule it</h1>
              <Field label="Publish at" htmlFor="when">
                <Input id="when" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button loading={busy} onClick={() => run(async () => {
                  await api(`/content/${content.id}/schedule`, { body: { scheduledAt: new Date(scheduleAt).toISOString() } });
                  toast.success('Scheduled');
                  await finish();
                })}>
                  <Check className="h-4 w-4" /> Schedule and finish
                </Button>
                <Button variant="ghost" onClick={finish}>
                  Finish without scheduling
                </Button>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
