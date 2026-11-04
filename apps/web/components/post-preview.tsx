'use client';

import { Bookmark, Heart, MessageCircle, Music2, Send, Share2, ThumbsUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { MediaAsset, PlatformKey } from '@/lib/types';
import { Modal } from './ui/overlay';

/** The text as it will be published. Same rule as composeCaption in @socialpilot/social. */
function publishedText(caption: string, hashtags: string[]) {
  const tags = hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).filter((h) => h.length > 1);
  const missing = tags.filter((h) => !caption.toLowerCase().includes(h.toLowerCase()));
  return missing.length ? `${caption.trim()}\n\n${missing.join(' ')}` : caption.trim();
}

/** Roughly where each app folds a long caption behind "more". */
const FOLD: Partial<Record<PlatformKey, number>> = { FACEBOOK: 480, INSTAGRAM: 125, LINKEDIN: 210, TIKTOK: 100 };

function Caption({ text, fold, className }: { text: string; fold?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const cut = fold !== undefined && !open && text.length > fold;
  return (
    <p className={`whitespace-pre-wrap break-words ${className ?? ''}`}>
      {cut ? `${text.slice(0, fold).trimEnd()}… ` : text}
      {cut && <button type="button" className="font-medium opacity-70 hover:underline" onClick={() => setOpen(true)}>more</button>}
    </p>
  );
}

function Photo({ item, className }: { item?: MediaAsset; className: string }) {
  if (!item) return null;
  if (item.kind === 'VIDEO') return <video src={item.url} controls className={`${className} bg-black object-contain`} />;
  return <img src={item.url} alt="" className={`${className} object-cover`} />;
}

const Avatar = ({ name }: { name: string }) => <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-clearance-soft text-sm font-semibold text-ink">{name.charAt(0).toUpperCase()}</span>;
const Stat = ({ children }: { children: ReactNode }) => <span className="inline-flex items-center gap-1.5">{children}</span>;

function Layout({ platform, name, text, media }: { platform: PlatformKey; name: string; text: string; media: MediaAsset[] }) {
  const first = media[0];
  const fold = FOLD[platform];
  const more = media.length > 1 ? <p className="px-3 pb-2 text-xs text-ink-3">+ {media.length - 1} more</p> : null;
  if (platform === 'TIKTOK') {
    return (
      <div className="relative mx-auto aspect-[9/16] max-h-[62vh] overflow-hidden rounded-xl bg-[#111] text-white">
        <Photo item={first} className="h-full w-full" />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 pr-12 text-sm">
          <p className="font-semibold">@{name.toLowerCase().replace(/\s+/g, '')}</p>
          <Caption text={text} fold={fold} className="mt-1" />
          <p className="mt-2 inline-flex items-center gap-1 text-xs"><Music2 className="h-3 w-3" /> Original sound</p>
        </div>
        <div className="absolute bottom-16 right-2 flex flex-col items-center gap-4"><Heart className="h-6 w-6" /><MessageCircle className="h-6 w-6" /><Bookmark className="h-6 w-6" /><Share2 className="h-6 w-6" /></div>
      </div>
    );
  }
  if (platform === 'INSTAGRAM') {
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-surface text-sm">
        <div className="flex items-center gap-2 p-3"><Avatar name={name} /><span className="font-semibold">{name.toLowerCase().replace(/\s+/g, '')}</span></div>
        <Photo item={first} className="aspect-[4/5] max-h-[52vh] w-full" />
        {more}
        <div className="flex gap-4 px-3 pt-3"><Heart className="h-5 w-5" /><MessageCircle className="h-5 w-5" /><Send className="h-5 w-5" /><Bookmark className="ml-auto h-5 w-5" /></div>
        <div className="p-3"><Caption text={text} fold={fold} /></div>
      </div>
    );
  }
  // Facebook and LinkedIn: text above the picture.
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface text-sm">
      <div className="flex items-center gap-2 p-3"><Avatar name={name} /><span><span className="block font-semibold">{name}</span><span className="block text-xs text-ink-3">Just now</span></span></div>
      <div className="px-3 pb-3"><Caption text={text} fold={fold} /></div>
      <Photo item={first} className="max-h-[46vh] w-full" />
      {more}
      <div className="flex justify-around border-t border-line p-2 text-xs text-ink-2">
        <Stat><ThumbsUp className="h-4 w-4" /> Like</Stat>
        <Stat><MessageCircle className="h-4 w-4" /> Comment</Stat>
        <Stat><Share2 className="h-4 w-4" /> {platform === 'LINKEDIN' ? 'Repost' : 'Share'}</Stat>
      </div>
    </div>
  );
}

/** An approximate look at a platform version before publishing, using what's in the editor now. */
export function PostPreview({ platform, platformLabel, name, caption, hashtags, media, onClose }: { platform: PlatformKey; platformLabel: string; name: string; caption: string; hashtags: string[]; media: MediaAsset[]; onClose: () => void }) {
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${platformLabel} preview`} description={`Close to how it will look. ${platformLabel} decides the exact layout and cropping.`}>
      <div className="max-h-[70vh] overflow-y-auto">
        <div className="mx-auto max-w-sm">
          <Layout platform={platform} name={name} text={publishedText(caption, hashtags)} media={media} />
        </div>
      </div>
    </Modal>
  );
}
