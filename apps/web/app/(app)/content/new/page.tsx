'use client';

import { ClientSelect } from '@/components/client-select';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PlatformChip, platformName } from '@/components/domain';
import { Button, cn, Field, Input, PageHeader, Panel, PanelHeader, Select, Tabs, Textarea } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Content, PlatformKey, SocialAccount } from '@/lib/types';

const PUBLISHABLE: PlatformKey[] = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK'];

export default function NewContentPage() {
  const router = useRouter();
  const { clients, clientId: scopedClient } = useSession();
  const [mode, setMode] = useState<'ai' | 'manual'>('ai');
  const [clientId, setClientId] = useState(scopedClient ?? clients[0]?.id ?? '');
  const [platforms, setPlatforms] = useState<PlatformKey[]>([]);
  const [ai, setAi] = useState({ topic: '', campaignGoal: '', tone: '', language: '', contentType: 'POST', additionalInstructions: '' });
  const [manual, setManual] = useState({ title: '', baseContent: '' });
  const accounts = useQuery({ queryKey: ['accounts', clientId], queryFn: () => api<SocialAccount[]>('/social/accounts', { query: { clientId } }), enabled: Boolean(clientId) });

  useEffect(() => {
    if (accounts.data) setPlatforms([...new Set(accounts.data.filter((a) => a.capabilities.publishing && a.status === 'ACTIVE').map((a) => a.platform))]);
  }, [accounts.data]);

  const toggle = (p: PlatformKey) => setPlatforms((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]));

  const generate = useMutation({
    mutationFn: () =>
      api<{ content: Content; missingInformation: string[] }>('/content/generate', {
        body: { clientId, platforms, topic: ai.topic, campaignGoal: ai.campaignGoal || null, tone: ai.tone || null, language: ai.language || undefined, contentType: ai.contentType, additionalInstructions: ai.additionalInstructions || null },
      }),
    onSuccess: (res) => {
      toast.success(res.missingInformation.length ? 'Draft ready. Some facts were left out; see the note on the draft.' : 'Draft ready');
      router.push(`/content/${res.content.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const create = useMutation({
    mutationFn: () =>
      api<Content>('/content', {
        body: {
          clientId,
          title: manual.title,
          baseContent: manual.baseContent,
          contentType: 'POST',
          variants: platforms.map((p) => ({ platform: p, socialAccountId: accounts.data?.find((a) => a.platform === p)?.id ?? null, caption: manual.baseContent, hashtags: [] })),
        },
      }),
    onSuccess: (c) => router.push(`/content/${c.id}`),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
      <PageHeader title="New post" description="Start from an idea and let AI write a version for each platform, or write it yourself." />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_320px]">
        <Panel>
          <div className="px-5 pt-3">
            <Tabs value={mode} onChange={setMode} items={[{ value: 'ai', label: 'Generate with AI' }, { value: 'manual', label: 'Write manually' }]} />
          </div>
          <div className="space-y-4 p-5">
            <Field label="Client" htmlFor="client">
              <ClientSelect id="client" value={clientId || null} onChange={(v) => v && setClientId(v)} />
            </Field>
            {mode === 'ai' ? (
              <>
                <Field label="What is the post about?" htmlFor="topic">
                  <Input id="topic" value={ai.topic} onChange={(e) => setAi({ ...ai, topic: e.target.value })} placeholder="Weekend baking classes for beginners" />
                </Field>
                <Field label="Campaign goal" htmlFor="goal" hint="Optional, e.g. fill Saturday class spots">
                  <Input id="goal" value={ai.campaignGoal} onChange={(e) => setAi({ ...ai, campaignGoal: e.target.value })} />
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Tone" htmlFor="tone" hint="Defaults to the brand tone">
                    <Input id="tone" value={ai.tone} onChange={(e) => setAi({ ...ai, tone: e.target.value })} />
                  </Field>
                  <Field label="Language" htmlFor="lang" hint="e.g. en, es, fr">
                    <Input id="lang" value={ai.language} onChange={(e) => setAi({ ...ai, language: e.target.value })} />
                  </Field>
                  <Field label="Format" htmlFor="type">
                    <Select id="type" value={ai.contentType} onChange={(e) => setAi({ ...ai, contentType: e.target.value })}>
                      {['POST', 'IMAGE', 'VIDEO', 'CAROUSEL', 'REEL', 'ARTICLE'].map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
                    </Select>
                  </Field>
                </div>
                <Field label="Anything else the writer should know?" htmlFor="extra">
                  <Textarea id="extra" value={ai.additionalInstructions} onChange={(e) => setAi({ ...ai, additionalInstructions: e.target.value })} placeholder="Mention the early-bird discount only if it’s in the brand profile" />
                </Field>
                <Button loading={generate.isPending} disabled={!ai.topic.trim() || !platforms.length || !clientId} onClick={() => generate.mutate()}>
                  <Sparkles className="h-4 w-4" /> Generate drafts
                </Button>
              </>
            ) : (
              <>
                <Field label="Title" htmlFor="title" hint="Internal name for this post">
                  <Input id="title" value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} />
                </Field>
                <Field label="Post text" htmlFor="body" hint="Used as the starting caption for every platform; tailor each one next.">
                  <Textarea id="body" className="min-h-40" value={manual.baseContent} onChange={(e) => setManual({ ...manual, baseContent: e.target.value })} />
                </Field>
                <Button loading={create.isPending} disabled={!manual.title.trim() || !manual.baseContent.trim() || !clientId} onClick={() => create.mutate()}>
                  Create draft
                </Button>
              </>
            )}
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="Platforms" description="One tailored version per platform." />
          <ul className="space-y-1 p-3">
            {PUBLISHABLE.map((p) => {
              const acct = accounts.data?.find((a) => a.platform === p && a.status === 'ACTIVE');
              return (
                <li key={p}>
                  <label className={cn('flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 hover:bg-surface-2', !acct && 'opacity-70')}>
                    <input type="checkbox" checked={platforms.includes(p)} onChange={() => toggle(p)} />
                    <PlatformChip platform={p} />
                    <span className="flex-1 text-sm">
                      {platformName(p)}
                      <span className="block text-xs text-ink-3">{acct ? acct.displayName : 'No account connected yet'}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-line px-5 py-3 text-xs text-ink-3">WhatsApp is messaging-only, so it has no feed to publish to.</p>
        </Panel>
      </div>
    </>
  );
}
