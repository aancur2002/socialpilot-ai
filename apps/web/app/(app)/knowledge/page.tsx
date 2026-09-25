'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, Search, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ago, humanize } from '@/components/domain';
import { ConfirmButton, Modal } from '@/components/ui/overlay';
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { KnowledgeSource, MediaAsset } from '@/lib/types';

const STATUS_TONE = { READY: 'clearance', PROCESSING: 'sky', PENDING: 'sky', FAILED: 'alert' } as const;

export default function KnowledgePage() {
  const { clientId, clients, setClientId, can } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ type: 'FAQ', title: '', content: '', url: '' });
  const [file, setFile] = useState<File | null>(null);
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const sources = useQuery({ queryKey: ['knowledge', clientId], queryFn: () => api<KnowledgeSource[]>('/knowledge', { query: { clientId } }), enabled: Boolean(clientId), refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'PENDING' || s.status === 'PROCESSING') ? 3000 : false) });
  const add = useMutation({
    mutationFn: async () => {
      let mediaId: string | undefined;
      if ((form.type === 'DOCUMENT' || form.type === 'PDF') && file) {
        const fd = new FormData();
        fd.append('clientId', clientId!);
        fd.append('purpose', 'knowledge');
        fd.append('file', file);
        mediaId = (await api<MediaAsset>('/media', { form: fd })).id;
      }
      return api('/knowledge', { body: { clientId, type: form.type, title: form.title, ...(form.content ? { content: form.content } : {}), ...(form.url ? { url: form.url } : {}), ...(mediaId ? { mediaId } : {}) } });
    },
    onSuccess: () => {
      toast.success('Added. It will be searchable in a moment.');
      setOpen(false);
      setForm({ type: 'FAQ', title: '', content: '', url: '' });
      setFile(null);
      qc.invalidateQueries({ queryKey: ['knowledge'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const search = useMutation({ mutationFn: () => api<{ id: string; title: string; content: string; score: number }[]>('/knowledge/search', { body: { clientId, query, limit: 5 } }), onError: (e) => toast.error(errorMessage(e)) });
  const isFile = form.type === 'DOCUMENT' || form.type === 'PDF';

  return (
    <>
      <PageHeader
        title="Knowledge base"
        description="Facts the AI may use when replying: FAQs, prices, policies, documents and web pages. Each client’s knowledge is only ever used for that client."
        actions={
          <>
            <Select aria-label="Client" className="w-56" value={clientId ?? ''} onChange={(e) => setClientId(e.target.value || null)}>
              <option value="">Choose a client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            {can('knowledge:manage') && clientId && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add knowledge</Button>}
          </>
        }
      />
      {!clientId ? (
        <Panel><EmptyState icon={<BookOpen className="h-8 w-8" />} title="Choose a client" /></Panel>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_380px]">
          <Panel>
            {sources.isLoading && <div className="space-y-2 p-4">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>}
            {sources.error && <ErrorState error={sources.error} onRetry={() => sources.refetch()} />}
            {sources.data?.length === 0 && <EmptyState icon={<BookOpen className="h-8 w-8" />} title="No knowledge yet" description="Add your FAQs first; they answer most customer questions." />}
            <ul className="divide-y divide-line">
              {sources.data?.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{s.title}</p>
                    <p className="text-xs text-ink-3">{humanize(s.type)}, {s.chunkCount} passages, added {ago(s.createdAt)}{s.url ? `, ${s.url}` : ''}</p>
                    {s.error && <p className="text-xs text-alert">{s.error}</p>}
                  </div>
                  <Badge tone={STATUS_TONE[s.status]}>{humanize(s.status)}</Badge>
                  {can('knowledge:manage') && (
                    <ConfirmButton variant="ghost" title="Remove this source?" description="The AI will no longer use it for replies." confirmLabel="Remove" onConfirm={async () => { await api(`/knowledge/${s.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['knowledge'] }); }}>
                      <Trash2 className="h-4 w-4" />
                    </ConfirmButton>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
          <Panel>
            <PanelHeader title="Test a question" description="See which passages the AI would read." />
            <div className="space-y-3 p-5">
              <div className="flex gap-2">
                <Input aria-label="Question" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Do you deliver on Sundays?" onKeyDown={(e) => e.key === 'Enter' && query.trim() && search.mutate()} />
                <Button variant="secondary" size="icon" aria-label="Search" disabled={!query.trim()} loading={search.isPending} onClick={() => search.mutate()}><Search className="h-4 w-4" /></Button>
              </div>
              {search.data?.length === 0 && <p className="text-sm text-ink-2">No passages found. The AI would hand this question to a person.</p>}
              <ul className="space-y-2">
                {search.data?.map((h) => (
                  <li key={h.id} className="rounded-[var(--radius-control)] border border-line p-3 text-sm">
                    <p className="flex items-center justify-between text-xs text-ink-3"><span>{h.title}</span><span className="tabular-nums">similarity {h.score.toFixed(2)}</span></p>
                    <p className="mt-1 line-clamp-4">{h.content}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        </div>
      )}
      <Modal open={open} onOpenChange={setOpen} title="Add knowledge" wide footer={<Button loading={add.isPending} disabled={!form.title.trim() || (isFile ? !file : form.type === 'WEBSITE' ? !form.url : !form.content.trim())} onClick={() => add.mutate()}>Add to knowledge base</Button>}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Type" htmlFor="k-type">
              <Select id="k-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="FAQ">FAQ</option>
                <option value="MANUAL">Notes</option>
                <option value="PRODUCT">Products</option>
                <option value="SERVICE">Services</option>
                <option value="WEBSITE">Web page</option>
                <option value="DOCUMENT">Document (PDF or text file)</option>
              </Select>
            </Field>
            <Field label="Title" htmlFor="k-title"><Input id="k-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Delivery and returns" /></Field>
          </div>
          {form.type === 'WEBSITE' ? (
            <Field label="Page URL" htmlFor="k-url" hint="Public pages only; the text is fetched once."><Input id="k-url" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" /></Field>
          ) : isFile ? (
            <Field label="File" htmlFor="k-file" hint="PDF, TXT, Markdown or CSV">
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>Choose file</Button>
                <span className="text-sm text-ink-2">{file?.name ?? 'No file chosen'}</span>
                <input ref={fileRef} id="k-file" type="file" hidden accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>
            </Field>
          ) : (
            <Field label="Content" htmlFor="k-content" hint="Plain facts work best, e.g. “We open 8am to 6pm, Monday to Saturday.”"><Textarea id="k-content" className="min-h-48" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} /></Field>
          )}
        </div>
      </Modal>
    </>
  );
}
