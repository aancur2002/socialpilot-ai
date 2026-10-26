'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ImagePlus, Scissors, Sparkles, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ClientSelect } from '@/components/client-select';
import { Badge, Button, cn, EmptyState, Field, Input, PageHeader, Panel, PanelHeader, Skeleton, Textarea } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { MediaAsset } from '@/lib/types';

interface CutoutResult { cutout: MediaAsset; studio: MediaAsset; matches: number; model: string; provider: string }
interface SceneResult { media: MediaAsset; model: string; provider: string }

const BACKGROUNDS = ['#f4f2ee', '#ffffff', '#fde8d0', '#e3efe6', '#e4ebf5', '#1f2933'];
const SCENES = [
  'on a marble kitchen counter in soft morning light',
  'on a rustic wooden table in a cosy café',
  'on a festive Dashain table with marigold flowers and diyo lamps',
  'outdoors on a stone ledge with Himalayan mountains softly blurred behind',
  'on a clean pastel backdrop with soft studio lighting',
];
const GENERATED = /-(cutout|studio|scene)\.png$/;
const byModel = (provider: string, real: string) => (provider === 'mock' ? 'the offline stand-in' : real);

/** Transparent areas shown as a light checkerboard, the usual cue for a cutout. */
const checkerboard = { backgroundImage: 'conic-gradient(var(--color-line) 25%, transparent 0 50%, var(--color-line) 0 75%, transparent 0)', backgroundSize: '20px 20px' };

function Result({ title, media, note, checker }: { title: string; media: MediaAsset; note: string; checker?: boolean }) {
  return (
    <figure className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
      <div className="grid aspect-square place-items-center bg-surface-2" style={checker ? checkerboard : undefined}>
        <img src={media.url} alt={title} className="max-h-full max-w-full object-contain" />
      </div>
      <figcaption className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <span>
          <span className="block font-medium text-ink">{title}</span>
          <span className="text-ink-3">{note}</span>
        </span>
        <a href={media.url} download={media.fileName} className="inline-flex items-center gap-1 text-ink-2 hover:text-ink" aria-label={`Download ${title}`}>
          <Download className="h-4 w-4" />
        </a>
      </figcaption>
    </figure>
  );
}

export default function PhotoStudioPage() {
  const qc = useQueryClient();
  const { clientId: scope } = useSession();
  const [clientId, setClientId] = useState<string | null>(scope);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [product, setProduct] = useState('');
  const [background, setBackground] = useState(BACKGROUNDS[0]!);
  const [cut, setCut] = useState<CutoutResult | null>(null);
  const [scene, setScene] = useState(SCENES[0]!);
  const [scenes, setScenes] = useState<SceneResult[]>([]);

  useEffect(() => {
    setPhotoId(null);
    setCut(null);
    setScenes([]);
  }, [clientId]);

  const photos = useQuery({
    queryKey: ['media', clientId, 'IMAGE'],
    queryFn: () => api<MediaAsset[]>('/media', { query: { clientId: clientId!, kind: 'IMAGE' } }),
    enabled: Boolean(clientId),
  });
  const sources = (photos.data ?? []).filter((m) => !GENERATED.test(m.fileName)).slice(0, 12);
  const photo = sources.find((m) => m.id === photoId) ?? null;

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('clientId', clientId!);
      form.append('file', file);
      return api<MediaAsset>('/media', { form });
    },
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: ['media', clientId] });
      setPhotoId(m.id);
      setCut(null);
      setScenes([]);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cutout = useMutation({
    mutationFn: () => api<CutoutResult>('/studio/cutout', { body: { mediaId: photoId, product, background } }),
    onSuccess: (r) => {
      setCut(r);
      setScenes([]);
      qc.invalidateQueries({ queryKey: ['media', clientId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const makeScene = useMutation({
    mutationFn: () => api<SceneResult>('/studio/scene', { body: { cutoutMediaId: cut!.cutout.id, product, scene } }),
    onSuccess: (r) => {
      setScenes((s) => [r, ...s]);
      qc.invalidateQueries({ queryKey: ['media', clientId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Photo studio" description="Turn a quick phone photo of a product into clean post images. SAM 3.1 cuts the product out; Muse Image puts it in a new scene. Results are saved to the media library, ready for posts." />
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="1. Cut out the product" />
            <div className="space-y-4 p-4">
              <Field label="Client" htmlFor="st-client"><ClientSelect id="st-client" value={clientId} onChange={setClientId} /></Field>
              <Field label="Photo" htmlFor="st-upload">
                <div className="space-y-2">
                  <div className="grid grid-cols-4 gap-2">
                    {photos.isLoading && clientId && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-square" />)}
                    {sources.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => { setPhotoId(m.id); setCut(null); setScenes([]); }}
                        className={cn('aspect-square overflow-hidden rounded-[var(--radius-control)] border-2', m.id === photoId ? 'border-sky' : 'border-transparent hover:border-line')}
                        aria-pressed={m.id === photoId}
                        aria-label={m.fileName}
                      >
                        <img src={m.url} alt="" className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                  <label htmlFor="st-upload" className={cn('flex cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-control)] border border-dashed border-line px-3 py-2.5 text-sm text-ink-2 hover:border-ink-3', !clientId && 'pointer-events-none opacity-50')}>
                    <Upload className="h-4 w-4" /> {upload.isPending ? 'Uploading…' : 'Upload a product photo'}
                  </label>
                  <input id="st-upload" type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={!clientId} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
                </div>
              </Field>
              <Field label="What's the product?" htmlFor="st-product" hint="A short name SAM 3.1 can find in the photo, like “cake” or “red handbag”.">
                <Input id="st-product" value={product} maxLength={80} onChange={(e) => setProduct(e.target.value)} placeholder="chocolate cake" />
              </Field>
              <Field label="Studio background" htmlFor="st-bg">
                <div className="flex flex-wrap items-center gap-2">
                  {BACKGROUNDS.map((c) => (
                    <button key={c} type="button" onClick={() => setBackground(c)} aria-label={`Background ${c}`} aria-pressed={background === c} className={cn('h-7 w-7 rounded-full border', background === c ? 'ring-2 ring-sky ring-offset-2 ring-offset-surface' : 'border-line')} style={{ background: c }} />
                  ))}
                  <input id="st-bg" type="color" value={background} onChange={(e) => setBackground(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent" aria-label="Custom background colour" />
                </div>
              </Field>
              <Button className="w-full" loading={cutout.isPending} disabled={!photoId || !product.trim()} onClick={() => cutout.mutate()}>
                <Scissors className="h-4 w-4" /> Cut out with SAM 3.1
              </Button>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="2. Put it in a new scene" />
            <div className="space-y-4 p-4">
              <div className="flex flex-wrap gap-1.5">
                {SCENES.map((s) => (
                  <button key={s} type="button" onClick={() => setScene(s)} className={cn('rounded-full border px-2.5 py-1 text-left text-xs', scene === s ? 'border-sky bg-sky-soft text-ink' : 'border-line text-ink-2 hover:border-ink-3')}>
                    {s.replace(/^on (a |an )?|^outdoors on (a )?/, '')}
                  </button>
                ))}
              </div>
              <Field label="Scene" htmlFor="st-scene">
                <Textarea id="st-scene" rows={3} value={scene} maxLength={500} onChange={(e) => setScene(e.target.value)} />
              </Field>
              <Button className="w-full" variant={cut ? 'primary' : 'secondary'} loading={makeScene.isPending} disabled={!cut || scene.trim().length < 3} onClick={() => makeScene.mutate()}>
                <Sparkles className="h-4 w-4" /> Create scene with Muse Image
              </Button>
              {!cut && <p className="text-xs text-ink-3">Cut out a product first; the scene keeps the product exactly as it is.</p>}
            </div>
          </Panel>
        </div>

        <div className="space-y-6">
          {!photo && !cut ? (
            <Panel>
              <EmptyState icon={<ImagePlus className="h-8 w-8" />} title="Start with a product photo" description="Pick or upload a photo, name the product, and the studio makes a transparent cutout and a clean square post image. Then try it in a few scenes." />
            </Panel>
          ) : (
            <Panel>
              <PanelHeader title="Results" actions={cut ? <Badge tone="clearance">{cut.matches === 1 ? '1 match' : `${cut.matches} matches`} found by {byModel(cut.provider, 'SAM 3.1')}</Badge> : undefined} />
              <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
                {photo && <Result title="Original" media={photo} note="Your photo" />}
                {cutout.isPending && [0, 1].map((i) => <Skeleton key={i} className="aspect-square" />)}
                {cut && (
                  <>
                    <Result title="Cutout" media={cut.cutout} note={`Transparent PNG, by ${byModel(cut.provider, 'SAM 3.1')}`} checker />
                    <Result title="Studio shot" media={cut.studio} note="1080 × 1080, ready for Instagram" />
                  </>
                )}
                {makeScene.isPending && <Skeleton className="aspect-square" />}
                {scenes.map((s) => (
                  <Result key={s.media.id} title="Scene" media={s.media} note={`By ${byModel(s.provider, 'Muse Image')}`} />
                ))}
              </div>
              {cut && <p className="border-t border-line px-4 py-3 text-xs text-ink-3">Saved to this client&apos;s media library. Attach them to a post from the post editor.</p>}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
