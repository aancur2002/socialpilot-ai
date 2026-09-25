'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, CheckCheck, MessageSquarePlus, RefreshCw, Send, UserRound, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ConversationDetail, ConversationListItem, Member, Paged, SocialAccount } from '@/lib/types';
import { ago, ConfidenceMeter, humanize, MockBadge, PlatformChip, when } from './domain';
import { Modal } from './ui/overlay';
import { Badge, Button, cn, EmptyState, ErrorState, Field, Input, Select, Skeleton, Textarea } from './ui/primitives';

const STATUS_STRIP: Record<ConversationListItem['status'], string> = { OPEN: 'strip-sky', PENDING: 'strip-runway', ESCALATED: 'strip-alert', RESOLVED: 'strip-clearance', SPAM: 'strip-idle' };

function SimulateInbound({ onDone }: { onDone: () => void }) {
  const { clientId } = useSession();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ socialAccountId: '', type: 'message' as 'message' | 'comment', text: '', fromName: 'Test Customer' });
  const accounts = useQuery({ queryKey: ['accounts', clientId], queryFn: () => api<SocialAccount[]>('/social/accounts', { query: { clientId } }), enabled: open });
  const mockAccounts = accounts.data?.filter((a) => a.isMock && (a.capabilities.directMessages || a.capabilities.comments)) ?? [];
  const send = useMutation({
    mutationFn: () => api('/dev/simulate-inbound', { body: form }),
    onSuccess: () => {
      toast.success('Message received. The AI will process it in a moment.');
      setOpen(false);
      setForm((f) => ({ ...f, text: '' }));
      setTimeout(onDone, 1500);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <MessageSquarePlus className="h-4 w-4" /> Simulate message
      </Button>
      <Modal open={open} onOpenChange={setOpen} title="Simulate an inbound message" description="Sends a signed test webhook for a mock account through the real pipeline." footer={<Button loading={send.isPending} disabled={!form.socialAccountId || !form.text.trim()} onClick={() => send.mutate()}>Send test message</Button>}>
        <div className="space-y-4">
          <Field label="Mock account" htmlFor="sim-acc">
            <Select id="sim-acc" value={form.socialAccountId} onChange={(e) => setForm({ ...form, socialAccountId: e.target.value })}>
              <option value="">Choose an account</option>
              {mockAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName} ({humanize(a.platform)})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" htmlFor="sim-type">
            <Select id="sim-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'message' | 'comment' })}>
              <option value="message">Direct message</option>
              <option value="comment">Comment</option>
            </Select>
          </Field>
          <Field label="From" htmlFor="sim-from">
            <Input id="sim-from" value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} />
          </Field>
          <Field label="Message" htmlFor="sim-text">
            <Textarea id="sim-text" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="How much is a sourdough loaf?" />
          </Field>
        </div>
      </Modal>
    </>
  );
}

function ConversationPanel({ id }: { id: string }) {
  const qc = useQueryClient();
  const { can, org } = useSession();
  const [draft, setDraft] = useState('');
  const [usingSuggestion, setUsingSuggestion] = useState<string | null>(null);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [reason, setReason] = useState('');
  const q = useQuery({ queryKey: ['conversation', id], queryFn: () => api<ConversationDetail>(`/inbox/conversations/${id}`), refetchInterval: 15_000 });
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ members: Member[] }>('/organizations/current/members'), enabled: can('users:view') });

  const pending = q.data?.suggestions.find((s) => ['PENDING_APPROVAL', 'ESCALATED', 'QUEUED_AFTER_HOURS'].includes(s.decision));
  useEffect(() => {
    if (pending && usingSuggestion === null && !draft) {
      setDraft(pending.suggestedReply);
      setUsingSuggestion(pending.id);
    }
  }, [pending, usingSuggestion, draft]);
  useEffect(() => {
    setDraft('');
    setUsingSuggestion(null);
  }, [id]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['conversation', id] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
  };
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isLoading) return <div className="space-y-3 p-6">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data!;
  const canReplyHere = c.type === 'COMMENT' ? c.socialAccount.capabilities.commentReplies : c.socialAccount.capabilities.directMessages;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <PlatformChip platform={c.platform} />
          <div>
            <p className="font-semibold">{c.contact.name ?? c.contact.username ?? 'Customer'}</p>
            <p className="text-xs text-ink-3">
              {c.type === 'COMMENT' ? 'Comment thread' : 'Direct message'} on {c.socialAccount.displayName}, {c.client.name}
            </p>
          </div>
          {c.socialAccount.isMock && <MockBadge />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={c.mode === 'AI' ? 'sky' : 'runway'}>{c.mode === 'AI' ? <><Bot className="h-3 w-3" /> AI mode</> : <><UserRound className="h-3 w-3" /> Human mode</>}</Badge>
          {can('messages:reply') && (
            <Button size="sm" variant="secondary" onClick={() => act.mutate(() => api(`/inbox/conversations/${id}`, { method: 'PATCH', body: { mode: c.mode === 'AI' ? 'HUMAN' : 'AI' } }))}>
              {c.mode === 'AI' ? 'Take over' : 'Return to AI'}
            </Button>
          )}
          {can('messages:assign') && c.status !== 'ESCALATED' && (
            <Button size="sm" variant="secondary" onClick={() => setEscalateOpen(true)}>
              <AlertTriangle className="h-4 w-4" /> Escalate
            </Button>
          )}
          {can('leads:manage') && !c.leads.length && (
            <Button size="sm" variant="secondary" onClick={() => act.mutate(async () => { await api(`/inbox/conversations/${id}/lead`, { body: {} }); toast.success('Lead created'); })}>
              <UserPlus className="h-4 w-4" /> Create lead
            </Button>
          )}
          {can('messages:reply') && c.status !== 'RESOLVED' && (
            <Button size="sm" onClick={() => act.mutate(() => api(`/inbox/conversations/${id}`, { method: 'PATCH', body: { status: 'RESOLVED' } }))}>
              <CheckCheck className="h-4 w-4" /> Mark resolved
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[1fr_280px]">
        <div className="flex min-h-0 flex-col">
          <ol className="flex-1 space-y-3 overflow-y-auto px-5 py-4" aria-label="Conversation history">
            {c.summary && (
              <li className="rounded-[var(--radius-control)] border border-dashed border-line px-3 py-2 text-xs text-ink-2">
                <span className="font-medium">Earlier in this conversation:</span> {c.summary}
              </li>
            )}
            {c.messages.map((m) => (
              <li key={m.id} className={cn('flex', m.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[78%] rounded-[var(--radius-panel)] px-3.5 py-2.5 text-sm', m.direction === 'OUTBOUND' ? 'bg-clearance-soft' : 'border border-line bg-surface', m.status === 'FAILED' && 'border border-alert')}>
                  <p className="whitespace-pre-wrap">{m.content}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                    {m.direction === 'OUTBOUND' ? (m.senderType === 'AI' ? 'Sent automatically by AI' : 'Sent by your team') : when(m.createdAt)}
                    {m.direction === 'OUTBOUND' && `, ${ago(m.createdAt)}`}
                    {m.intent && <Badge className="py-0">{humanize(m.intent)}</Badge>}
                    {m.isSpam && <Badge tone="alert" className="py-0">Spam</Badge>}
                    {m.status === 'FAILED' && <span className="text-alert">Not delivered: {m.error}</span>}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          {can('messages:reply') && (
            <div className="border-t border-line p-4">
              {pending && (
                <div className="mb-3 rounded-[var(--radius-control)] bg-sky-soft/60 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">AI suggestion</span>
                    <ConfidenceMeter value={pending.confidence} />
                    <Badge>{humanize(pending.intent)}</Badge>
                    <Badge tone={pending.decision === 'ESCALATED' ? 'alert' : 'runway'}>{humanize(pending.decision)}</Badge>
                  </div>
                  {pending.decisionReason && <p className="mt-1 text-ink-2">Why it wasn’t sent automatically: {pending.decisionReason}</p>}
                </div>
              )}
              {!canReplyHere ? (
                <p className="text-sm text-ink-2">{humanize(c.platform)} doesn’t allow replying to this {c.type === 'COMMENT' ? 'comment' : 'message'} through its API. Reply in the native app.</p>
              ) : (
                <>
                  <Textarea aria-label="Reply" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a reply" className="min-h-20" />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" loading={act.isPending && act.variables === undefined} onClick={() => act.mutate(async () => { await api(`/inbox/conversations/${id}/regenerate`, { body: {} }); setDraft(''); setUsingSuggestion(null); })}>
                        <RefreshCw className="h-4 w-4" /> Regenerate
                      </Button>
                      {pending && (
                        <Button variant="ghost" size="sm" onClick={() => act.mutate(async () => { await api(`/inbox/conversations/${id}/suggestions/${pending.id}/discard`, { body: {} }); setDraft(''); setUsingSuggestion(''); })}>
                          Discard suggestion
                        </Button>
                      )}
                    </div>
                    <Button
                      disabled={!draft.trim()}
                      loading={act.isPending}
                      onClick={() => act.mutate(async () => {
                        await api(`/inbox/conversations/${id}/reply`, { body: { text: draft, ...(usingSuggestion && pending && usingSuggestion === pending.id ? { suggestionId: pending.id } : {}) } });
                        setDraft('');
                        setUsingSuggestion('');
                        toast.success(org.mockMode && c.socialAccount.isMock ? 'Sent (mock account)' : 'Sent');
                      })}
                    >
                      <Send className="h-4 w-4" /> Send
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <aside className="hidden space-y-5 overflow-y-auto border-l border-line px-4 py-4 text-sm xl:block">
          <section>
            <h3 className="mb-2 text-xs font-medium text-ink-3">Customer</h3>
            <p className="font-medium">{c.contact.name ?? '—'}</p>
            {c.contact.username && <p className="text-ink-2">@{c.contact.username}</p>}
            {c.contact.email && <p className="text-ink-2">{c.contact.email}</p>}
            {c.contact.phone && <p className="text-ink-2">{c.contact.phone}</p>}
            {c.contact.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{c.contact.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
          </section>
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-ink-3">Handling</h3>
            <Field label="Status" htmlFor="c-status">
              <Select id="c-status" value={c.status} disabled={!can('messages:reply')} onChange={(e) => act.mutate(() => api(`/inbox/conversations/${id}`, { method: 'PATCH', body: { status: e.target.value } }))}>
                {['OPEN', 'PENDING', 'ESCALATED', 'RESOLVED', 'SPAM'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </Select>
            </Field>
            <Field label="Priority" htmlFor="c-priority">
              <Select id="c-priority" value={c.priority} disabled={!can('messages:assign')} onChange={(e) => act.mutate(() => api(`/inbox/conversations/${id}`, { method: 'PATCH', body: { priority: e.target.value } }))}>
                {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </Select>
            </Field>
            {members.data && (
              <Field label="Assigned to" htmlFor="c-assign">
                <Select id="c-assign" value={c.assignedToId ?? ''} disabled={!can('messages:assign')} onChange={(e) => act.mutate(() => api(`/inbox/conversations/${id}`, { method: 'PATCH', body: { assignedToId: e.target.value || null } }))}>
                  <option value="">Unassigned</option>
                  {members.data.members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
                </Select>
              </Field>
            )}
          </section>
          {c.escalations.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium text-ink-3">Open escalation</h3>
              {c.escalations.map((e) => <p key={e.id} className="strip strip-alert rounded-r bg-alert-soft/50 px-3 py-2">{humanize(e.reason)}</p>)}
            </section>
          )}
          {c.leads.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium text-ink-3">Lead</h3>
              {c.leads.map((l) => (
                <Link key={l.id} href={`/leads/${l.id}`} className="block rounded-[var(--radius-control)] border border-line px-3 py-2 hover:bg-surface-2">
                  <p className="font-medium">{l.interest ?? 'Interested customer'}</p>
                  <p className="text-xs text-ink-3">{humanize(l.status)}</p>
                </Link>
              ))}
            </section>
          )}
        </aside>
      </div>

      <Modal open={escalateOpen} onOpenChange={setEscalateOpen} title="Escalate to a person" description="AI replies stop for this conversation and your team is notified." footer={<Button variant="attention" disabled={!reason.trim()} onClick={() => act.mutate(async () => { await api(`/inbox/conversations/${id}/escalate`, { body: { reason } }); setEscalateOpen(false); setReason(''); })}>Escalate</Button>}>
        <Field label="Reason" htmlFor="esc-reason">
          <Input id="esc-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer wants to discuss a large order" />
        </Field>
      </Modal>
    </div>
  );
}

export function InboxView({ conversationId }: { conversationId?: string }) {
  const { clientId, org } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [platform, setPlatform] = useState('');
  const [search, setSearch] = useState('');
  const [mine, setMine] = useState(false);
  const list = useQuery({
    queryKey: ['conversations', clientId, status, platform, search, mine],
    queryFn: () => api<Paged<ConversationListItem>>('/inbox/conversations', { query: { clientId, status, platform, search, assignedToMe: mine || undefined, limit: 50 } }),
    refetchInterval: 15_000,
  });

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-3.5rem-var(--banner-h,0px))] sm:-mx-6 lg:-mx-8">
      <section className={cn('flex w-full min-w-0 flex-col border-r border-line bg-surface md:w-[380px] md:shrink-0', conversationId && 'hidden md:flex')} aria-label="Conversations">
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold">Inbox</h1>
            {org.mockMode && <SimulateInbound onDone={() => list.refetch()} />}
          </div>
          <Input aria-label="Search conversations" placeholder="Search name or message" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="flex gap-2">
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All open</option>
              {['OPEN', 'ESCALATED', 'PENDING', 'RESOLVED', 'SPAM'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </Select>
            <Select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">All platforms</option>
              {['FACEBOOK', 'INSTAGRAM', 'WHATSAPP', 'LINKEDIN', 'TIKTOK'].map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me
          </label>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {list.isLoading && <li className="space-y-2 p-3">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16" />)}</li>}
          {list.error && <li><ErrorState error={list.error} onRetry={() => list.refetch()} /></li>}
          {list.data?.items.length === 0 && <li><EmptyState title="No conversations" description="Messages and comments from connected accounts land here." /></li>}
          {list.data?.items.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => router.push(`/inbox/${c.id}`)}
                aria-current={c.id === conversationId ? 'true' : undefined}
                className={cn('strip block w-full border-b border-line px-3 py-3 text-left hover:bg-surface-2', STATUS_STRIP[c.status], c.id === conversationId && 'bg-surface-2')}
              >
                <div className="flex items-center gap-2">
                  <PlatformChip platform={c.platform} size="sm" />
                  <span className={cn('flex-1 truncate text-sm', c.unreadCount ? 'font-semibold' : 'font-medium')}>{c.contact.name ?? c.contact.username ?? 'Customer'}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">{ago(c.lastMessageAt)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-ink-2">{c.lastMessagePreview}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {c.unreadCount > 0 && <Badge tone="sky">{c.unreadCount} new</Badge>}
                  {c.lastIntent && <Badge>{humanize(c.lastIntent)}</Badge>}
                  {c.suggestions.length > 0 && <Badge tone="runway">Reply to review</Badge>}
                  {c.leads.length > 0 && <Badge tone="clearance">Lead</Badge>}
                  {c.mode === 'HUMAN' && <Badge tone="runway">Human</Badge>}
                  {(c.priority === 'HIGH' || c.priority === 'URGENT') && <Badge tone="alert">{humanize(c.priority)}</Badge>}
                  {!clientId && <span className="text-[11px] text-ink-3">{c.client.name}</span>}
                  <span className="ml-auto"><ConfidenceMeter value={c.lastConfidence} /></span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className={cn('min-w-0 flex-1 bg-paper', !conversationId && 'hidden md:block')}>
        {conversationId ? (
          <>
            <button className="border-b border-line px-4 py-2 text-sm text-clearance md:hidden" onClick={() => router.push('/inbox')}>
              Back to conversations
            </button>
            <ConversationPanel id={conversationId} />
          </>
        ) : (
          <EmptyState title="Pick a conversation" description="AI suggestions, customer details and reply tools appear here." />
        )}
      </section>
    </div>
  );
}
