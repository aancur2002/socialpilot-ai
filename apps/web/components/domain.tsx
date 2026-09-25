'use client';

import { formatDistanceToNowStrict, format } from 'date-fns';
import type { ContentStatus, PlatformKey } from '@/lib/types';
import { Badge, cn } from './ui/primitives';

/** Platform identity chip. Uses neutral lettermarks rather than brand logos. */
const PLATFORM_META: Record<PlatformKey, { short: string; name: string; color: string }> = {
  FACEBOOK: { short: 'Fb', name: 'Facebook', color: '#3b5bdb' },
  INSTAGRAM: { short: 'Ig', name: 'Instagram', color: '#c2255c' },
  WHATSAPP: { short: 'Wa', name: 'WhatsApp', color: '#2b8a3e' },
  LINKEDIN: { short: 'In', name: 'LinkedIn', color: '#1864ab' },
  TIKTOK: { short: 'Tt', name: 'TikTok', color: '#212529' },
  YOUTUBE: { short: 'Yt', name: 'YouTube', color: '#c92a2a' },
  X: { short: 'X', name: 'X', color: '#343a40' },
  PINTEREST: { short: 'Pi', name: 'Pinterest', color: '#a61e4d' },
  GOOGLE_BUSINESS: { short: 'Gb', name: 'Google Business', color: '#1971c2' },
  THREADS: { short: 'Th', name: 'Threads', color: '#495057' },
};

export const platformName = (p: PlatformKey) => PLATFORM_META[p]?.name ?? p;

export function PlatformChip({ platform, size = 'md', withName }: { platform: PlatformKey; size?: 'sm' | 'md'; withName?: boolean }) {
  const meta = PLATFORM_META[platform];
  return (
    <span className="inline-flex items-center gap-1.5" title={meta.name}>
      <span
        className={cn('inline-flex items-center justify-center rounded-[5px] font-semibold text-white', size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-6 w-6 text-[11px]')}
        style={{ backgroundColor: meta.color }}
        aria-hidden
      >
        {meta.short}
      </span>
      {withName ? <span className="text-sm">{meta.name}</span> : <span className="sr-only">{meta.name}</span>}
    </span>
  );
}

export function MockBadge() {
  return (
    <Badge tone="runway" title="Simulated development integration — nothing is sent to the real platform">
      Mock
    </Badge>
  );
}

const CONTENT_STATUS: Record<ContentStatus, { label: string; tone: 'neutral' | 'clearance' | 'runway' | 'alert' | 'sky'; strip: string }> = {
  DRAFT: { label: 'Draft', tone: 'neutral', strip: 'strip-idle' },
  PENDING_APPROVAL: { label: 'Pending approval', tone: 'runway', strip: 'strip-runway' },
  APPROVED: { label: 'Approved', tone: 'sky', strip: 'strip-sky' },
  SCHEDULED: { label: 'Scheduled', tone: 'sky', strip: 'strip-sky' },
  PUBLISHING: { label: 'Publishing', tone: 'sky', strip: 'strip-sky' },
  PUBLISHED: { label: 'Published', tone: 'clearance', strip: 'strip-clearance' },
  FAILED: { label: 'Failed', tone: 'alert', strip: 'strip-alert' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', strip: 'strip-idle' },
};

export const contentStrip = (s: ContentStatus) => CONTENT_STATUS[s].strip;
export function ContentStatusBadge({ status }: { status: ContentStatus }) {
  return <Badge tone={CONTENT_STATUS[status].tone}>{CONTENT_STATUS[status].label}</Badge>;
}

export const CONTENT_STATUS_COLORS: Record<ContentStatus, string> = {
  DRAFT: 'var(--ink-3)',
  PENDING_APPROVAL: 'var(--runway)',
  APPROVED: 'var(--sky)',
  SCHEDULED: 'var(--sky)',
  PUBLISHING: 'var(--sky)',
  PUBLISHED: 'var(--clearance)',
  FAILED: 'var(--alert)',
  CANCELLED: 'var(--ink-3)',
};

export function ConfidenceMeter({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-xs text-ink-3">—</span>;
  const pct = Math.round(value * 100);
  const tone = value >= 0.9 ? 'bg-clearance' : value >= 0.7 ? 'bg-runway' : 'bg-alert';
  return (
    <span className="inline-flex items-center gap-1.5" title="Model-reported confidence used for routing — not a measured accuracy rate">
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-surface-2">
        <span className={cn('block h-full', tone)} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs tabular-nums text-ink-2">{pct}%</span>
    </span>
  );
}

export const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const ago = (d: string | Date) => formatDistanceToNowStrict(new Date(d), { addSuffix: true });
export const when = (d: string | Date) => format(new Date(d), 'd MMM yyyy, HH:mm');
export const day = (d: string | Date) => format(new Date(d), 'd MMM yyyy');
