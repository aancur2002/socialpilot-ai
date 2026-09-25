'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, ImagePlus, RefreshCw, Send, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ContentStatusBadge, MockBadge, PlatformChip, platformName, when, humanize } from '@/components/domain';
import { ConfirmButton, Modal } from '@/components/ui/overlay';
import { Badge, Button, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Content, MediaAsset, PlatformKey, PlatformStatus, SocialAccount, Variant } from '@/lib/types';

function VariantEditor({ content, variant, accounts, caps, editable, onSaved }: { content: Content; variant: Variant; accounts: SocialAccount[]; caps?: PlatformStatus; editable: boolean; onSaved: (c: Content) => void }) {
  const [caption, setCaption] = useState(variant.caption);
  const [hashtags, setHashtags] = useState(variant.hashtags.join(' '));
  const [cta, setCta] = useState(variant.callToAction ?? '');
  const [accountId, setAccountId] = useState(variant.socialAccountId ?? '');
  const [media, setMedia] = useState<MediaAsset[]>(variant.media.map((m) => m.media));
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setCaption(variant.caption);
    setHashtags(variant.hashtags.join(' '));
    setCta(variant.callToAction ?? '');
    setAccountId(variant.socialAccountId ?? '');
    setMedia(variant.media.map((m) => m.media));
  }, [variant]);

  const tags = hashtags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean);
  const composedLength = caption.length + (tags.length ? 2 + tags.map((t) => `#${t}`).join(' ').length : 0);
  const max = caps?.capabilities.maxCaptionLength ?? 0;
  const platformAccounts = accounts.filter((a) => a.platform === variant.platform);
  const dirty = caption !== variant.caption || tags.join(' ') !== variant.hashtags.join(' ') || cta !== (variant.callToAction ?? '') || accountId !== (variant.socialAccountId ?? '') || media.map((m) => m.id).join() !== variant.media.map((m) => m.mediaId).join();

  const save = useMutation({
    mutationFn: () => api<Content>(`/content/${content.id}/variants/${variant.id}`, { method: 'PATCH', body: { caption, hashtags: tags, callToAction: cta || null, socialAccountId: accountId || null, mediaIds: media.map((m) => m.id) } }),
    onSuccess: (c) => {
      toast.success(content.status === 'DRAFT' ? 'Saved' : 'Saved. The post is back in draft and needs approval again.');
      onSaved(c);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const regenerate = useMutation({
    mutationFn: () => api<Content>(`/content/${content.id}/variants/${variant.id}/regenerate`, { body: {} }),
    onSuccess: (c) => {
      toast.success('New version written');
      onSaved(c);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('clientId', content.clientId);
      form.append('file', file);
      return api<MediaAsset>('/media', { form });
    },
    onSuccess: (m) => setMedia((list) => [...list, m]),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <PlatformChip platform={variant.platform} withName />
          <ContentStatusBadge status={variant.status} />
        </div>
        {editable && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" loading={regenerate.isPending} onClick={() => regenerate.mutate()}>
              <RefreshCw className="h-4 w-4" /> Rewrite
            </Button>
            <ConfirmButton variant="ghost" title={`Remove the ${platformName(variant.platform)} version?`} description="This platform version will be deleted from the post." confirmLabel="Remove version" onConfirm={async () => onSaved(await api<Content>(`/content/${content.id}/variants/${variant.id}`, { method: 'DELETE' }))}>
              <Trash2 className="h-4 w-4" />
            </ConfirmButton>
          </div>
        )}
      </div>
      <div className="space-y-4 p-5">
        <Field label="Publish to" htmlFor={`acct-${variant.id}`}>
          <Select id={`acct-${variant.id}`} value={accountId} disabled={!editable} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose an account</option>
            {platformAccounts.map((a) => <option key={a.id} value={a.id}>{a.displayName}{a.isMock ? ' (mock)' : ''}{a.status !== 'ACTIVE' ? ` (${humanize(a.status)})` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Caption" htmlFor={`cap-${variant.id}`} hint={max ? `${composedLength} of ${max} characters including hashtags` : undefined} error={max && composedLength > max ? `Too long for ${platformName(variant.platform)} (${composedLength}/${max})` : undefined}>
          <Textarea id={`cap-${variant.id}`} className="min-h-32" value={caption} disabled={!editable} onChange={(e) => setCaption(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Hashtags" htmlFor={`tags-${variant.id}`} hint="Separate with spaces">
            <Input id={`tags-${variant.id}`} value={hashtags} disabled={!editable} onChange={(e) => setHashtags(e.target.value)} />
          </Field>
          <Field label="Call to action" htmlFor={`cta-${variant.id}`}>
            <Input id={`cta-${variant.id}`} value={cta} disabled={!editable} onChange={(e) => setCta(e.target.value)} />
          </Field>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">Media</p>
          <div className="flex flex-wrap gap-2">
            {media.map((m) => (
              <div key={m.id} className="relative h-20 w-20 overflow-hidden rounded-[var(--radius-control)] border border-line bg-surface-2">
                {m.kind === 'IMAGE' ? <img src={m.url} alt={m.fileName} className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center p-1 text-center text-[10px] text-ink-2">{m.fileName}</span>}
                {editable && (
                  <button className="absolute right-0.5 top-0.5 rounded bg-[#0d1524]/70 p-0.5 text-white" aria-label={`Remove ${m.fileName}`} onClick={() => setMedia((l) => l.filter((x) => x.id !== m.id))}>
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
            {editable && (
              <button className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border border-dashed border-line text-xs text-ink-3 hover:bg-surface-2" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                <ImagePlus className="h-5 w-5" /> {upload.isPending ? 'Uploading' : 'Add'}
              </button>
            )}
            <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
          </div>
          {caps?.capabilities.requiresMedia && media.length === 0 && <p className="mt-1.5 text-xs text-runway">{platformName(variant.platform)} needs an image or video.</p>}
          {variant.mediaPrompt && <p className="mt-2 text-xs text-ink-2"><span className="font-medium">Creative brief from AI:</span> {variant.mediaPrompt}</p>}
        </div>
        {caps && caps.capabilities.notes.length > 0 && (
          <details className="text-xs text-ink-2">
            <summary className="cursor-pointer">{platformName(variant.platform)} rules</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{caps.capabilities.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </details>
        )}
        {editable && (
          <div className="flex justify-end">
            <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save version
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default function ContentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = useSession();
  const q = useQuery({ queryKey: ['content-item', id], queryFn: () => api<Content>(`/content/${id}`), refetchInterval: (query) => (['SCHEDULED', 'PUBLISHING'].includes(query.state.data?.status ?? '') ? 10_000 : false) });
  const accounts = useQuery({ queryKey: ['accounts', q.data?.clientId], queryFn: () => api<SocialAccount[]>('/social/accounts', { query: { clientId: q.data!.clientId } }), enabled: Boolean(q.data) });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => api<{ platforms: PlatformStatus[] }>('/social/platforms') });
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(() => new Date(Date.now() + 3600_000).toISOString().slice(0, 16));
  const [decision, setDecision] = useState<'REJECT' | 'REQUEST_CHANGES' | null>(null);
  const [comment, setComment] = useState('');
  const [addPlatform, setAddPlatform] = useState<PlatformKey | ''>('');

  const setData = (c: Content) => {
    qc.setQueryData(['content-item', id], c);
    qc.invalidateQueries({ queryKey: ['content'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const act = useMutation({
    mutationFn: ({ fn }: { fn: () => Promise<Content>; success: string }) => fn(),
    onSuccess: (c, v) => {
      setData(c);
      toast.success(v.success);
    },
    onError: (e) => {
      const message = errorMessage(e);
      toast.error(message, { id: message });
    },
  });

  if (q.isLoading) return <div className="space-y-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}</div>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data!;
  const editable = can('content:edit') && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'FAILED', 'CANCELLED'].includes(c.status);
  const existingPlatforms = new Set(c.variants.map((v) => v.platform));
  const addable = (['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK'] as PlatformKey[]).filter((p) => !existingPlatforms.has(p));

  return (
    <>
      <PageHeader
        title={c.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <ContentStatusBadge status={c.status} />
            {c.aiGenerated && <Badge tone="sky">AI draft</Badge>}
            {c.scheduledAt && <span>Planned for {when(c.scheduledAt)}</span>}
          </span>
        }
        actions={
          <>
            {can('content:edit') && (c.status === 'DRAFT' || c.status === 'FAILED') && (
              <Button variant="attention" onClick={() => act.mutate({ fn: () => api(`/content/${id}/submit`, { body: {} }), success: 'Sent for approval' })}>
                Submit for approval
              </Button>
            )}
            {can('content:approve') && c.status === 'PENDING_APPROVAL' && (
              <>
                <Button onClick={() => act.mutate({ fn: () => api(`/content/${id}/approve`, { body: { decision: 'APPROVE' } }), success: 'Approved' })}>Approve</Button>
                <Button variant="secondary" onClick={() => setDecision('REQUEST_CHANGES')}>Request changes</Button>
                <Button variant="secondary" onClick={() => setDecision('REJECT')}>Reject</Button>
              </>
            )}
            {can('content:publish') && ['APPROVED', 'DRAFT', 'FAILED', 'SCHEDULED'].includes(c.status) && (
              <>
                <Button variant={c.status === 'APPROVED' ? 'primary' : 'secondary'} onClick={() => setScheduleOpen(true)}>
                  {c.status === 'SCHEDULED' ? 'Reschedule' : 'Schedule'}
                </Button>
                {c.status !== 'SCHEDULED' && (
                  <ConfirmButton variant="secondary" size="md" title="Publish now?" description="Each platform version is published to its selected account right away." confirmLabel="Publish now" onConfirm={() => act.mutateAsync({ fn: () => api(`/content/${id}/publish`, { body: {} }), success: 'Publishing started' })}>
                    <Send className="h-4 w-4" /> Publish now
                  </ConfirmButton>
                )}
              </>
            )}
            {can('content:publish') && c.status === 'SCHEDULED' && (
              <Button variant="ghost" onClick={() => act.mutate({ fn: () => api(`/content/${id}/cancel-schedule`, { body: {} }), success: 'Schedule cancelled' })}>Cancel schedule</Button>
            )}
            {can('content:create') && (
              <Button variant="ghost" size="icon" aria-label="Duplicate" onClick={async () => router.push(`/content/${(await api<Content>(`/content/${id}/duplicate`, { body: {} })).id}`)}>
                <Copy className="h-4 w-4" />
              </Button>
            )}
            {can('content:delete') && c.status !== 'PUBLISHING' && (
              <ConfirmButton title="Delete this post?" description="It will be removed from the calendar and any pending schedule is cancelled. Published posts stay on the platforms." confirmLabel="Delete post" onConfirm={async () => { await api(`/content/${id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['content'] }); router.replace('/content'); }}>
                <Trash2 className="h-4 w-4" />
              </ConfirmButton>
            )}
          </>
        }
      />

      {c.rejectionReason && c.status === 'DRAFT' && <p className="strip strip-runway mb-4 rounded-r-md bg-runway-soft px-4 py-2.5 text-sm">Reviewer feedback: {c.rejectionReason}</p>}
      {c.missingInfo.length > 0 && (
        <div className="strip strip-runway mb-4 rounded-r-md bg-runway-soft px-4 py-3 text-sm">
          <p className="font-medium">The AI didn’t have these facts, so it left them out:</p>
          <ul className="mt-1 list-disc pl-5">{c.missingInfo.map((m) => <li key={m}>{m}</li>)}</ul>
          <Link href={`/clients/${c.clientId}`} className="mt-1 inline-block text-clearance hover:underline">Add them to the brand profile</Link>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {c.variants.map((v) => (
            <VariantEditor key={v.id} content={c} variant={v} accounts={accounts.data ?? []} caps={platforms.data?.platforms.find((p) => p.platform === v.platform)} editable={editable} onSaved={setData} />
          ))}
          {editable && addable.length > 0 && (
            <div className="flex items-center gap-2">
              <Select className="max-w-64" aria-label="Add platform" value={addPlatform} onChange={(e) => setAddPlatform(e.target.value as PlatformKey)}>
                <option value="">Add a platform version</option>
                {addable.map((p) => <option key={p} value={p}>{platformName(p)}</option>)}
              </Select>
              <Button variant="secondary" disabled={!addPlatform} onClick={() => addPlatform && act.mutate({ fn: () => api(`/content/${id}/variants`, { body: { platform: addPlatform, caption: c.baseContent, hashtags: [], socialAccountId: accounts.data?.find((a) => a.platform === addPlatform)?.id ?? null } }), success: 'Version added' })}>
                Add
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Idea" />
            <div className="space-y-2 p-5 text-sm">
              <p className="whitespace-pre-wrap">{c.baseContent}</p>
              {c.topic && <p className="text-ink-2">Topic: {c.topic}</p>}
              {c.objective && <p className="text-ink-2">Goal: {c.objective}</p>}
            </div>
          </Panel>
          {c.scheduledPosts.length > 0 && (
            <Panel>
              <PanelHeader title="Publishing" />
              <ul className="divide-y divide-line">
                {c.scheduledPosts.map((p) => (
                  <li key={p.id} className="px-5 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <PlatformChip platform={p.socialAccount.platform} size="sm" />
                      <span className="flex-1 truncate">{p.socialAccount.displayName}</span>
                      {p.socialAccount.isMock && <MockBadge />}
                      <Badge tone={p.status === 'PUBLISHED' ? 'clearance' : p.status === 'FAILED' ? 'alert' : p.status === 'CANCELLED' ? 'neutral' : 'sky'}>{humanize(p.status)}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-3">
                      {p.publishedPost ? `Published ${when(p.publishedPost.publishedAt)}` : `For ${when(p.scheduledAt)}`}
                      {p.attempts > 0 && `, attempt ${p.attempts} of ${p.maxAttempts}`}
                    </p>
                    {p.lastError && p.status !== 'PUBLISHED' && <p className="mt-1 text-xs text-alert">{p.lastError}</p>}
                    {p.publishedPost?.url && !p.socialAccount.isMock && (
                      <a href={p.publishedPost.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-clearance hover:underline">
                        View post <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {c.approvals.length > 0 && (
            <Panel>
              <PanelHeader title="Approval history" />
              <ul className="divide-y divide-line">
                {c.approvals.map((a) => (
                  <li key={a.id} className="px-5 py-3 text-sm">
                    <Badge tone={a.status === 'APPROVED' ? 'clearance' : a.status === 'PENDING' ? 'runway' : a.status === 'CANCELLED' ? 'neutral' : 'alert'}>{humanize(a.status)}</Badge>
                    <p className="mt-1 text-xs text-ink-3">{when(a.decidedAt ?? a.createdAt)}</p>
                    {a.comment && <p className="mt-1 text-ink-2">{a.comment}</p>}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      <Modal open={scheduleOpen} onOpenChange={setScheduleOpen} title="Schedule post" description="Every platform version publishes at this time to its selected account." footer={<Button loading={act.isPending} onClick={() => act.mutate({ fn: () => api(c.status === 'SCHEDULED' ? `/content/${id}/reschedule` : `/content/${id}/schedule`, { body: { scheduledAt: new Date(scheduleAt).toISOString() } }), success: 'Scheduled' }, { onSuccess: () => setScheduleOpen(false) })}>Schedule</Button>}>
        <Field label="Publish at (your local time)" htmlFor="sched">
          <Input id="sched" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
        </Field>
      </Modal>
      <Modal open={decision !== null} onOpenChange={(o) => !o && setDecision(null)} title={decision === 'REJECT' ? 'Reject post' : 'Request changes'} footer={<Button variant={decision === 'REJECT' ? 'danger' : 'attention'} onClick={() => act.mutate({ fn: () => api(`/content/${id}/approve`, { body: { decision, comment: comment || null } }), success: decision === 'REJECT' ? 'Rejected' : 'Changes requested' }, { onSuccess: () => { setDecision(null); setComment(''); } })}>{decision === 'REJECT' ? 'Reject' : 'Request changes'}</Button>}>
        <Field label="Feedback for the author" htmlFor="fb">
          <Textarea id="fb" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
