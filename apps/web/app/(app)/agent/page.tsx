'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ExternalLink, Square } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ClientSelect } from '@/components/client-select';
import { ago, ContentStatusBadge, day, PlatformChip } from '@/components/domain';
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ContentStatus, PlatformKey } from '@/lib/types';

interface Step { at: string; tool: string; input: Record<string, unknown>; output: Record<string, unknown>; ok: boolean }
interface RunContent { id: string; title: string; status: ContentStatus; scheduledAt: string | null; variants: { platform: PlatformKey; caption: string; media: { media: { url: string; kind: string } }[] }[] }
interface Run {
  id: string;
  goal: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  steps: Step[];
  summary: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  finishedAt: string | null;
  client: { id: string; name: string };
  contents: RunContent[];
}
interface RunListItem { id: string; goal: string; status: Run['status']; summary: string | null; createdAt: string; client: { id: string; name: string } }

const EXAMPLES = ['Fill our weekend baking classes this month', 'Launch our new seasonal menu', 'Get more bookings for next week', 'Promote our weekend sale'];
const ACTIVE = new Set(['QUEUED', 'RUNNING']);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** One timeline line per agent step, in plain words. */
function describe(step: Step): { title: string; detail?: string; tone: string } {
  const i = step.input;
  const o = step.output;
  if (!step.ok) return { title: `Couldn't ${verb(step.tool)}`, detail: String(o.error ?? ''), tone: 'strip-alert' };
  switch (step.tool) {
    case 'get_business_profile': return { title: 'Read the business profile', detail: `Connected: ${((o.connectedPlatforms as string[]) ?? []).map((p) => p.toLowerCase()).join(', ') || 'none'}`, tone: 'strip-sky' };
    case 'search_knowledge': return { title: 'Checked the facts in the knowledge base', detail: `“${String(i.query ?? '')}”: ${(o.snippets as unknown[] | undefined)?.length ?? 0} found`, tone: 'strip-sky' };
    case 'get_recent_posts': return { title: 'Looked at recent posts to avoid repeating them', tone: 'strip-sky' };
    case 'create_signup_form': return { title: 'Created a sign-up form', detail: String(o.link ?? ''), tone: 'strip-clearance' };
    case 'create_post_draft': return { title: `Drafted “${String(o.title ?? i.title ?? 'post')}”`, detail: `${o.plannedDate ? day(String(o.plannedDate)) : ''}, ${((o.platforms as string[]) ?? []).map((p) => p.toLowerCase()).join(', ')}`, tone: 'strip-clearance' };
    case 'generate_post_image': return { title: `Created the ${String(i.platform ?? '').toLowerCase()} image with ${o.provider === 'mock' ? 'a placeholder' : 'Muse Image'}`, tone: 'strip-clearance' };
    case 'finish': return { title: 'Finished and sent everything for approval', tone: 'strip-runway' };
    default: return { title: step.tool, tone: 'strip-sky' };
  }
}
/** Captions with [placeholders] the owner must fill in highlighted. */
function Caption({ text }: { text: string }) {
  return <>{text.split(/(\[[^\]\n]{1,60}\])/g).map((part, i) => (/^\[.*\]$/.test(part) ? <mark key={i} className="rounded bg-runway-soft px-0.5 text-ink">{part}</mark> : part))}</>;
}
const placeholderCount = (contents: RunContent[]) => contents.reduce((n, c) => n + c.variants.reduce((m, v) => m + (v.caption.match(/\[[^\]\n]{1,60}\]/g)?.length ?? 0), 0), 0);

const verb = (tool: string) => ({ get_business_profile: 'read the profile', search_knowledge: 'search the knowledge base', get_recent_posts: 'read recent posts', create_signup_form: 'create the form', create_post_draft: 'draft a post', generate_post_image: 'create an image' })[tool] ?? tool.replace(/_/g, ' ');

export default function CampaignAgentPage() {
  const { can, clientId: scope } = useSession();
  const qc = useQueryClient();
  const [clientId, setClientId] = useState<string | null>(scope);
  const [goal, setGoal] = useState('');
  const [days, setDays] = useState(7);
  const [startDate, setStartDate] = useState(tomorrow);
  const [runId, setRunId] = useState<string | null>(null);
  useEffect(() => setClientId((c) => c ?? scope), [scope]);

  const runs = useQuery({ queryKey: ['agent-runs'], queryFn: () => api<RunListItem[]>('/agent/campaigns') });
  const run = useQuery({
    queryKey: ['agent-run', runId],
    queryFn: () => api<Run>(`/agent/campaigns/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (q) => (q.state.data && !ACTIVE.has(q.state.data.status) ? false : 2000),
  });
  useEffect(() => {
    if (run.data && !ACTIVE.has(run.data.status)) qc.invalidateQueries({ queryKey: ['agent-runs'] });
  }, [run.data, qc]);

  const start = useMutation({
    mutationFn: () => api<{ id: string }>('/agent/campaigns', { body: { clientId, goal, days, startDate } }),
    onSuccess: (r) => { setRunId(r.id); qc.invalidateQueries({ queryKey: ['agent-runs'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/agent/campaigns/${runId}/cancel`, { body: {} }),
    onSuccess: () => { toast.success('Run stopped'); run.refetch(); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!can('content:create')) return <EmptyState title="You don't have access to the Campaign Agent" />;
  const r = run.data;

  return (
    <>
      <PageHeader title="Campaign Agent" description="Give a goal; the agent plans a campaign, writes the posts, makes the images and sets up a sign-up form. Everything waits for your approval." />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[400px_1fr]">
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="New campaign" />
            <div className="space-y-4 p-5">
              <Field label="Client" htmlFor="ag-client"><ClientSelect id="ag-client" value={clientId} onChange={setClientId} /></Field>
              <Field label="Goal" htmlFor="ag-goal" hint="What should this campaign achieve? The agent uses the client's profile and knowledge base for the facts.">
                <Textarea id="ag-goal" rows={3} placeholder="e.g. Fill our weekend baking classes this month" value={goal} onChange={(e) => setGoal(e.target.value)} />
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((ex) => <button key={ex} type="button" onClick={() => setGoal(ex)} className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-2 hover:bg-surface-2">{ex}</button>)}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Starts" htmlFor="ag-start"><Input id="ag-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
                <Field label="Length" htmlFor="ag-days">
                  <Select id="ag-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {[3, 5, 7, 10, 14].map((d) => <option key={d} value={d}>{d} days</option>)}
                  </Select>
                </Field>
              </div>
              <Button className="w-full" loading={start.isPending} disabled={!clientId || goal.trim().length < 10 || (r ? ACTIVE.has(r.status) : false)} onClick={() => start.mutate()}>
                <Bot className="h-4 w-4" /> Plan the campaign
              </Button>
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="Earlier runs" />
            {runs.isLoading ? <Skeleton className="m-5 h-20" /> : !runs.data?.length ? <p className="px-5 py-4 text-sm text-ink-3">No runs yet.</p> : (
              <ul className="divide-y divide-line">
                {runs.data.map((x) => (
                  <li key={x.id}>
                    <button type="button" onClick={() => setRunId(x.id)} className={`w-full px-5 py-3 text-left hover:bg-surface-2 ${x.id === runId ? 'bg-surface-2' : ''}`}>
                      <p className="line-clamp-1 text-sm font-medium">{x.goal}</p>
                      <p className="text-xs text-ink-3">{x.client.name}, {ago(x.createdAt)}, {x.status.toLowerCase()}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          {!runId ? (
            <Panel><EmptyState icon={<Bot className="h-8 w-8" />} title="Plan a campaign" description="The agent's steps appear here as it works: reading the business profile, checking facts, drafting posts, creating images and a sign-up form." /></Panel>
          ) : run.isLoading ? <Skeleton className="h-96" /> : run.error ? <ErrorState error={run.error} /> : r && (
            <>
              <Panel>
                <PanelHeader
                  title={r.goal}
                  description={`${r.client.name}${r.provider ? `, using ${r.provider === 'mock' ? 'the offline AI' : `${r.provider} (${r.model})`}` : ''}`}
                  actions={
                    <div className="flex items-center gap-2">
                      <Badge tone={r.status === 'COMPLETED' ? 'clearance' : r.status === 'FAILED' ? 'alert' : r.status === 'CANCELLED' ? 'neutral' : 'sky'}>{ACTIVE.has(r.status) ? 'Working…' : r.status.toLowerCase()}</Badge>
                      {ACTIVE.has(r.status) && <Button size="sm" variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate()}><Square className="h-3.5 w-3.5" /> Stop</Button>}
                    </div>
                  }
                />
                <ol className="space-y-2 p-5" aria-label="Agent steps">
                  {r.steps.map((s, idx) => {
                    const d = describe(s);
                    return (
                      <li key={idx} className={`strip ${d.tone} rounded-r-md bg-surface-2 px-4 py-2.5`}>
                        <p className="text-sm font-medium">{d.title}</p>
                        {d.detail && (d.detail.startsWith('http') ? <a href={d.detail} target="_blank" rel="noreferrer" className="text-xs text-clearance hover:underline">{d.detail}</a> : <p className="text-xs text-ink-2">{d.detail}</p>)}
                      </li>
                    );
                  })}
                  {ACTIVE.has(r.status) && <li className="strip strip-sky animate-pulse rounded-r-md bg-surface-2 px-4 py-2.5 text-sm text-ink-2">{r.status === 'QUEUED' ? 'Starting…' : 'Thinking about the next step…'}</li>}
                </ol>
                {r.error && r.status === 'FAILED' && <p className="border-t border-line px-5 py-3 text-sm text-alert">{r.error}</p>}
                {r.summary && !ACTIVE.has(r.status) && (
                  <div className="border-t border-line px-5 py-4">
                    <p className="text-sm">{r.summary}</p>
                    {placeholderCount(r.contents) > 0 && <p className="mt-2 text-sm text-ink-2"><mark className="rounded bg-runway-soft px-1 text-ink">{placeholderCount(r.contents)} placeholder{placeholderCount(r.contents) === 1 ? '' : 's'}</mark> to fill in where the knowledge base didn't have the detail.</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link href="/approvals"><Button size="sm">Review in Approvals</Button></Link>
                      <Link href="/calendar"><Button size="sm" variant="secondary">See the calendar</Button></Link>
                    </div>
                    <p className="mt-2 text-xs text-ink-3">{r.steps.length} steps, {(r.inputTokens + r.outputTokens).toLocaleString()} tokens</p>
                  </div>
                )}
              </Panel>

              {r.contents.length > 0 && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {r.contents.map((c) => {
                    const v = c.variants.find((x) => x.media.length) ?? c.variants[0];
                    const img = v?.media[0]?.media;
                    return (
                      <Panel key={c.id} className="overflow-hidden">
                        {img?.kind === 'IMAGE' ? <img src={img.url} alt="" className="aspect-[4/3] w-full object-cover" /> : <div className="flex aspect-[4/3] w-full items-center justify-center bg-surface-2 text-xs text-ink-3">No image yet</div>}
                        <div className="space-y-2 p-4">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium">{c.title}</p>
                            <ContentStatusBadge status={c.status} />
                          </div>
                          <p className="text-xs text-ink-3">{c.scheduledAt ? day(c.scheduledAt) : 'No date'}</p>
                          <div className="flex gap-1">{c.variants.map((x) => <PlatformChip key={x.platform} platform={x.platform} size="sm" />)}</div>
                          {v && <p className="line-clamp-4 text-sm text-ink-2"><Caption text={v.caption} /></p>}
                          <Link href={`/content/${c.id}`} className="inline-flex items-center gap-1 text-sm text-clearance hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Open post</Link>
                        </div>
                      </Panel>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
