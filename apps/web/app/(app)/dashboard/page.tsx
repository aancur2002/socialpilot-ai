'use client';

import { useQuery } from '@tanstack/react-query';
import { addDays } from 'date-fns';
import Link from 'next/link';
import { ContentStatusBadge, contentStrip, PlatformChip, when, ago } from '@/components/domain';
import { EmptyState, ErrorState, PageHeader, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ContentStatus, ConversationListItem, Dashboard, Paged, PlatformKey } from '@/lib/types';

interface CalendarItem {
  id: string;
  title: string;
  status: ContentStatus;
  scheduledAt: string | null;
  client: { name: string };
  variants: { platform: PlatformKey }[];
}

const COUNTERS: { key: keyof Dashboard; label: string; href: string; attention?: boolean }[] = [
  { key: 'unreadMessages', label: 'Unread messages', href: '/inbox' },
  { key: 'pendingApprovals', label: 'Pending approvals', href: '/approvals', attention: true },
  { key: 'openEscalations', label: 'Escalations', href: '/inbox?status=ESCALATED', attention: true },
  { key: 'scheduledPosts', label: 'Scheduled posts', href: '/calendar' },
  { key: 'publishedPosts30d', label: 'Published, 30 days', href: '/content?status=PUBLISHED' },
  { key: 'failedPosts30d', label: 'Failed, 30 days', href: '/content?status=FAILED', attention: true },
  { key: 'newLeads', label: 'New leads', href: '/leads' },
  { key: 'connectedAccounts', label: 'Connected accounts', href: '/social-accounts' },
];

export default function DashboardPage() {
  const { clientId, me, can } = useSession();
  const dash = useQuery({ queryKey: ['dashboard', clientId], queryFn: () => api<Dashboard>('/dashboard', { query: { clientId } }) });
  const escalated = useQuery({
    queryKey: ['conversations', clientId, 'ESCALATED'],
    queryFn: () => api<Paged<ConversationListItem>>('/inbox/conversations', { query: { clientId, status: 'ESCALATED', limit: 6 } }),
    enabled: can('messages:view'),
  });
  const attention = useQuery({
    queryKey: ['content', clientId, 'attention'],
    queryFn: async () => {
      const [pending, failed] = await Promise.all([
        api<Paged<CalendarItem>>('/content', { query: { clientId, status: 'PENDING_APPROVAL', limit: 6 } }),
        api<Paged<CalendarItem>>('/content', { query: { clientId, status: 'FAILED', limit: 6 } }),
      ]);
      return [...failed.items, ...pending.items];
    },
    enabled: can('content:view'),
  });
  const upcoming = useQuery({
    queryKey: ['calendar', clientId, 'upcoming'],
    queryFn: () => api<CalendarItem[]>('/calendar', { query: { clientId, from: new Date().toISOString(), to: addDays(new Date(), 14).toISOString() } }),
    enabled: can('content:view'),
  });

  const firstName = me.user.name.split(' ')[0];
  return (
    <>
      <PageHeader title={`Good to see you, ${firstName}`} description="What needs a decision now, and what’s going out next." />

      <section aria-label="Key numbers" className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-4 xl:grid-cols-8">
        {COUNTERS.map((c) => {
          const value = dash.data?.[c.key];
          if (value === null) return null;
          const hot = c.attention && typeof value === 'number' && value > 0;
          return (
            <Link key={c.key} href={c.href} className="bg-surface px-4 py-3 hover:bg-surface-2">
              {dash.isLoading ? <Skeleton className="h-6 w-10" /> : <p className={`text-xl font-semibold tabular-nums ${hot ? 'text-runway' : ''}`}>{value ?? 0}</p>}
              <p className="mt-0.5 text-xs text-ink-2">{c.label}</p>
            </Link>
          );
        })}
      </section>
      {dash.error && <ErrorState error={dash.error} onRetry={() => dash.refetch()} />}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Panel>
          <PanelHeader title="Needs attention" description="Escalated conversations, posts waiting for approval and failed posts." />
          <ul className="space-y-2 p-4">
            {escalated.data?.items.map((c) => (
              <li key={c.id}>
                <Link href={`/inbox/${c.id}`} className="strip strip-alert flex items-center gap-3 rounded-r-md bg-surface-2/60 px-4 py-2.5 hover:bg-surface-2">
                  <PlatformChip platform={c.platform} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.contact.name ?? c.contact.username ?? 'Customer'}: {c.lastMessagePreview}</p>
                    <p className="text-xs text-ink-3">Escalated conversation, {c.client.name}, {ago(c.lastMessageAt)}</p>
                  </div>
                </Link>
              </li>
            ))}
            {attention.data?.map((item) => (
              <li key={item.id}>
                <Link href={`/content/${item.id}`} className={`strip ${contentStrip(item.status)} flex items-center gap-3 rounded-r-md bg-surface-2/60 px-4 py-2.5 hover:bg-surface-2`}>
                  <div className="flex -space-x-1">{item.variants.map((v, i) => <PlatformChip key={i} platform={v.platform} size="sm" />)}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-ink-3">{item.client.name}</p>
                  </div>
                  <ContentStatusBadge status={item.status} />
                </Link>
              </li>
            ))}
            {!escalated.isLoading && !attention.isLoading && !escalated.data?.items.length && !attention.data?.length && (
              <EmptyState title="Nothing is waiting on you" description="Escalations, approvals and failed posts will appear here." />
            )}
            {(escalated.isLoading || attention.isLoading) && [0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
          </ul>
        </Panel>

        <Panel>
          <PanelHeader title="Going out next" description="The next 14 days." />
          <ul className="divide-y divide-line">
            {upcoming.data?.filter((i) => i.scheduledAt).slice(0, 10).map((item) => (
              <li key={item.id}>
                <Link href={`/content/${item.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
                  <div className="w-24 shrink-0 text-xs tabular-nums text-ink-2">{when(item.scheduledAt!)}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-ink-3">{item.client.name}</p>
                  </div>
                  <ContentStatusBadge status={item.status} />
                </Link>
              </li>
            ))}
            {upcoming.data && !upcoming.data.some((i) => i.scheduledAt) && (
              <EmptyState title="Nothing scheduled" description="Approved posts you schedule will line up here." action={can('content:create') ? <Link href="/content/new" className="text-sm font-medium text-clearance hover:underline">Create a post</Link> : undefined} />
            )}
            {upcoming.isLoading && <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>}
          </ul>
        </Panel>
      </div>
    </>
  );
}
