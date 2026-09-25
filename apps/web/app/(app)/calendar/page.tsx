'use client';

import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ContentStatusBadge, CONTENT_STATUS_COLORS, PlatformChip, when } from '@/components/domain';
import { Button, cn, EmptyState, ErrorState, PageHeader, Panel, Skeleton, Tabs } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ContentStatus, PlatformKey } from '@/lib/types';

interface CalItem {
  id: string;
  title: string;
  status: ContentStatus;
  scheduledAt: string | null;
  client: { name: string };
  variants: { id: string; platform: PlatformKey }[];
  scheduledPosts: { publishedPost: { publishedAt: string } | null }[];
}

const itemDate = (i: CalItem) => new Date(i.scheduledAt ?? i.scheduledPosts.find((p) => p.publishedPost)?.publishedPost?.publishedAt ?? Date.now());
const LOCKED: ContentStatus[] = ['PUBLISHED', 'PUBLISHING', 'CANCELLED'];

function Chip({ item, draggable }: { item: CalItem; draggable: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.id, disabled: !draggable });
  return (
    <Link
      ref={setNodeRef}
      href={`/content/${item.id}`}
      {...(draggable ? { ...attributes, ...listeners } : {})}
      style={{ borderLeftColor: CONTENT_STATUS_COLORS[item.status], transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined }}
      className={cn('block truncate rounded-r border-l-[3px] bg-surface px-1.5 py-1 text-[11px] leading-tight shadow-sm hover:bg-surface-2', isDragging && 'z-10 opacity-80', draggable && 'cursor-grab')}
      title={`${item.title} (${item.status.toLowerCase().replace('_', ' ')})`}
    >
      <span className="tabular-nums text-ink-3">{format(itemDate(item), 'HH:mm')}</span> {item.title}
    </Link>
  );
}

function DayCell({ date, items, muted, canEdit, tall }: { date: Date; items: CalItem[]; muted?: boolean; canEdit: boolean; tall?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: date.toISOString() });
  const today = isSameDay(date, new Date());
  return (
    <div ref={setNodeRef} className={cn('flex flex-col gap-1 bg-surface p-1.5', tall ? 'min-h-72' : 'min-h-28', muted && 'bg-surface-2/40', isOver && 'bg-sky-soft')}>
      <span className={cn('self-start rounded px-1 text-xs tabular-nums', today ? 'bg-clearance font-semibold text-clearance-ink' : muted ? 'text-ink-3' : 'text-ink-2')}>{format(date, tall ? 'EEE d' : 'd')}</span>
      {items.map((i) => <Chip key={i.id} item={i} draggable={canEdit && !LOCKED.includes(i.status)} />)}
    </div>
  );
}

export default function CalendarPage() {
  const { clientId, can } = useSession();
  const qc = useQueryClient();
  const [view, setView] = useState<'month' | 'week' | 'list'>('month');
  const [cursor, setCursor] = useState(new Date());
  const range = useMemo(() => {
    if (view === 'week') return { from: startOfWeek(cursor, { weekStartsOn: 1 }), to: endOfWeek(cursor, { weekStartsOn: 1 }) };
    return { from: startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), to: endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }) };
  }, [cursor, view]);
  const q = useQuery({ queryKey: ['calendar', clientId, range.from.toISOString(), range.to.toISOString()], queryFn: () => api<CalItem[]>('/calendar', { query: { clientId, from: range.from.toISOString(), to: range.to.toISOString() } }) });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const move = useMutation({
    mutationFn: ({ id, at }: { id: string; at: Date }) => api(`/content/${id}/reschedule`, { body: { scheduledAt: at.toISOString() } }),
    onSuccess: () => {
      toast.success('Rescheduled');
      qc.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      qc.invalidateQueries({ queryKey: ['calendar'] });
    },
  });

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const item = q.data?.find((i) => i.id === e.active.id);
    if (!item) return;
    const target = new Date(String(e.over.id));
    const old = itemDate(item);
    const at = new Date(target.getFullYear(), target.getMonth(), target.getDate(), old.getHours(), old.getMinutes());
    if (isSameDay(at, old)) return;
    if (at.getTime() < Date.now()) {
      toast.error('Pick a day in the future');
      return;
    }
    move.mutate({ id: item.id, at });
  };

  const days = eachDayOfInterval({ start: range.from, end: range.to });
  const itemsOn = (d: Date) => (q.data ?? []).filter((i) => isSameDay(itemDate(i), d)).sort((a, b) => itemDate(a).getTime() - itemDate(b).getTime());
  const step = (dir: 1 | -1) => setCursor((c) => (view === 'week' ? addWeeks(c, dir) : addMonths(c, dir)));

  return (
    <>
      <PageHeader
        title="Calendar"
        description={can('content:edit') ? 'Drag a post to another day to reschedule it. The time of day is kept.' : 'Planned and published posts.'}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="icon" aria-label="Previous" onClick={() => step(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="secondary" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
            <Button variant="secondary" size="icon" aria-label="Next" onClick={() => step(1)}><ChevronRight className="h-4 w-4" /></Button>
            <span className="min-w-36 text-sm font-medium">{view === 'week' ? `Week of ${format(range.from, 'd MMM')}` : format(cursor, 'MMMM yyyy')}</span>
          </div>
        }
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={view} onChange={setView} items={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'list', label: 'List' }]} />
        <div className="flex flex-wrap gap-3 text-xs text-ink-2">
          {(['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'PUBLISHED', 'FAILED'] as ContentStatus[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CONTENT_STATUS_COLORS[s] }} />{s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ')}</span>
          ))}
        </div>
      </div>
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.isLoading && <Skeleton className="h-[520px]" />}
      {q.data && view !== 'list' && (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <Panel className="overflow-hidden">
            <div className="grid grid-cols-7 border-b border-line bg-surface-2 text-center text-xs text-ink-3">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-2">{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-px bg-line">
              {days.map((d) => <DayCell key={d.toISOString()} date={d} items={itemsOn(d)} muted={view === 'month' && !isSameMonth(d, cursor)} canEdit={can('content:edit')} tall={view === 'week'} />)}
            </div>
          </Panel>
        </DndContext>
      )}
      {q.data && view === 'list' && (
        <Panel>
          {q.data.length === 0 && <EmptyState title="Nothing planned in this period" />}
          <ul className="divide-y divide-line">
            {[...q.data].sort((a, b) => itemDate(a).getTime() - itemDate(b).getTime()).map((i) => (
              <li key={i.id}>
                <Link href={`/content/${i.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-surface-2">
                  <span className="w-36 text-sm tabular-nums text-ink-2">{when(itemDate(i))}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{i.title}<span className="block text-xs font-normal text-ink-3">{i.client.name}</span></span>
                  <span className="flex gap-1">{i.variants.map((v) => <PlatformChip key={v.id} platform={v.platform} size="sm" />)}</span>
                  <ContentStatusBadge status={i.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <p className="mt-3 text-xs text-ink-3">Showing {format(range.from, 'd MMM')} to {format(addDays(range.to, 0), 'd MMM yyyy')}. Times are in your browser’s timezone.</p>
    </>
  );
}
