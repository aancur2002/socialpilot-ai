'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ago, humanize } from './domain';
import { Drawer } from './ui/overlay';
import { Badge, Button, ErrorState, Field, Input, Skeleton, Textarea } from './ui/primitives';

interface SourceDetail {
  id: string;
  type: string;
  title: string;
  content: string | null;
  url: string | null;
  mediaId: string | null;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  error: string | null;
  chunkCount: number;
  updatedAt: string;
  chunks: { id: string; index: number; content: string; tokenCount: number }[];
}

const STATUS_TONE = { READY: 'clearance', PROCESSING: 'sky', PENDING: 'sky', FAILED: 'alert' } as const;

/** View and edit one knowledge source: title, text, re-indexing and the indexed passages. */
export function KnowledgeSourceDrawer({ sourceId, onClose }: { sourceId: string | null; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const editable = can('knowledge:manage');
  const q = useQuery({
    queryKey: ['knowledge-source', sourceId],
    queryFn: () => api<SourceDetail>(`/knowledge/${sourceId}`),
    enabled: Boolean(sourceId),
    refetchInterval: (query) => (['PENDING', 'PROCESSING'].includes(query.state.data?.status ?? '') ? 2500 : false),
  });
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [showPassages, setShowPassages] = useState(false);
  const loadedAt = q.data?.updatedAt;
  useEffect(() => {
    if (q.data) {
      setTitle(q.data.title);
      setContent(q.data.content ?? '');
    }
    // Reset the form only when a different version of the source loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, loadedAt]);

  const refresh = (data?: SourceDetail) => {
    if (data) qc.setQueryData(['knowledge-source', sourceId], data);
    qc.invalidateQueries({ queryKey: ['knowledge'] });
  };
  const save = useMutation({
    mutationFn: () => {
      const body: { title?: string; content?: string } = {};
      if (title !== q.data?.title) body.title = title;
      if (content !== (q.data?.content ?? '')) body.content = content;
      return api<SourceDetail>(`/knowledge/${sourceId}`, { method: 'PATCH', body });
    },
    onSuccess: (d) => {
      toast.success('Saved. Re-indexing now.');
      refresh(d);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reprocess = useMutation({
    mutationFn: () => api<SourceDetail>(`/knowledge/${sourceId}/reprocess`, { body: {} }),
    onSuccess: (d) => {
      toast.success('Re-reading the original and re-indexing');
      refresh(d);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const s = q.data;
  const hasOriginal = Boolean(s?.url || s?.mediaId);
  const contentDirty = s ? content !== (s.content ?? '') : false;
  const dirty = s ? title !== s.title || contentDirty : false;
  const busy = s?.status === 'PENDING' || s?.status === 'PROCESSING';

  return (
    <Drawer
      open={Boolean(sourceId)}
      onOpenChange={(o) => !o && onClose()}
      title={s?.title ?? 'Knowledge source'}
      wide
      footer={
        editable && s ? (
          <>
            {hasOriginal && (
              <Button variant="secondary" loading={reprocess.isPending} disabled={busy} onClick={() => reprocess.mutate()}>
                <RefreshCw className="h-4 w-4" /> Re-read {s.url ? 'page' : 'file'}
              </Button>
            )}
            {!hasOriginal && (
              <Button variant="secondary" loading={reprocess.isPending} disabled={busy} onClick={() => reprocess.mutate()}>
                <RefreshCw className="h-4 w-4" /> Re-index
              </Button>
            )}
            <Button disabled={!dirty || !title.trim() || !content.trim()} loading={save.isPending} onClick={() => save.mutate()}>
              Save changes
            </Button>
          </>
        ) : undefined
      }
    >
      {q.isLoading && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {s && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <Badge tone={STATUS_TONE[s.status]}>{humanize(s.status)}</Badge>
            <span>{humanize(s.type)}</span>
            <span>{s.chunkCount} passages</span>
            <span>updated {ago(s.updatedAt)}</span>
          </div>
          {s.error && <p className="rounded-[var(--radius-control)] bg-alert-soft px-3 py-2 text-sm text-alert">{s.error}</p>}
          {s.url && (
            <p className="text-sm text-ink-2">
              Source page:{' '}
              <a href={s.url} target="_blank" rel="noreferrer" className="text-clearance hover:underline">
                {s.url}
              </a>
            </p>
          )}
          {s.mediaId && <p className="text-sm text-ink-2">Source: uploaded document. The text below was extracted from it.</p>}

          <Field label="Title" htmlFor="ks-title" hint="Included with every passage, so a clear title helps the AI find it.">
            <Input id="ks-title" value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field
            label="Text the AI can use"
            htmlFor="ks-content"
            hint={busy && !s.content ? 'Text appears here once processing finishes.' : 'Write plain facts. The AI only answers from what is written here.'}
          >
            <Textarea id="ks-content" className="min-h-72 font-[inherit]" value={content} disabled={!editable} onChange={(e) => setContent(e.target.value)} />
          </Field>
          {hasOriginal && contentDirty && (
            <p className="rounded-[var(--radius-control)] bg-runway-soft px-3 py-2 text-sm">
              Saving edited text makes your version the source. The original {s.url ? 'page' : 'file'} won’t be re-read after that.
            </p>
          )}

          <div>
            <button className="text-sm font-medium text-clearance hover:underline" onClick={() => setShowPassages((v) => !v)}>
              {showPassages ? 'Hide' : 'Show'} indexed passages ({s.chunks.length})
            </button>
            {showPassages && (
              <ol className="mt-2 space-y-2">
                {s.chunks.map((c) => (
                  <li key={c.id} className="rounded-[var(--radius-control)] border border-line p-3 text-sm">
                    <p className="mb-1 text-xs text-ink-3">Passage {c.index + 1}, about {c.tokenCount} tokens</p>
                    <p className="whitespace-pre-wrap text-ink-2">{c.content}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
