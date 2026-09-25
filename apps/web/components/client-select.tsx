'use client';

import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/session';
import { cn } from './ui/primitives';

/** Closes a popover on outside click or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function SearchBox({ value, onChange, dark }: { value: string; onChange: (v: string) => void; dark?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2 border-b px-2.5', dark ? 'border-rail-active' : 'border-line')}>
      <Search className={cn('h-4 w-4 shrink-0', dark ? 'text-rail-ink' : 'text-ink-3')} aria-hidden />
      <input
        autoFocus
        aria-label="Search clients"
        placeholder="Search clients"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('h-9 w-full bg-transparent text-sm outline-none', dark ? 'text-white placeholder:text-rail-ink/70' : 'text-ink placeholder:text-ink-3')}
      />
    </div>
  );
}

const matches = (name: string, q: string) => !q || name.toLowerCase().includes(q.trim().toLowerCase());

/**
 * Searchable single-client picker. Scales to hundreds of clients.
 * `allLabel` adds a "no specific client" option (value null), e.g. "All clients".
 */
export function ClientSelect({
  id,
  value,
  onChange,
  allLabel,
  placeholder = 'Choose a client',
  variant = 'default',
  className,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: string | null;
  onChange: (id: string | null) => void;
  allLabel?: string;
  placeholder?: string;
  variant?: 'default' | 'rail';
  className?: string;
  'aria-label'?: string;
}) {
  const { clients } = useSession();
  const { open, setOpen, ref } = usePopover();
  const [q, setQ] = useState('');
  const dark = variant === 'rail';
  const selected = clients.find((c) => c.id === value);
  const shown = useMemo(() => clients.filter((c) => matches(c.name, q)), [clients, q]);

  const choose = (v: string | null) => {
    onChange(v);
    setOpen(false);
    setQ('');
  };

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-[var(--radius-control)] border px-3 text-left text-sm',
          dark ? 'border-rail-active bg-rail-active text-white' : 'border-line bg-surface text-ink',
        )}
      >
        <span className={cn('truncate', !selected && !allLabel && (dark ? 'text-rail-ink' : 'text-ink-3'))}>{selected?.name ?? (value === null && allLabel ? allLabel : placeholder)}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
      </button>
      {open && (
        <div className={cn('absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-[var(--radius-panel)] border shadow-lg', dark ? 'border-rail-active bg-rail' : 'border-line bg-surface')}>
          {clients.length > 6 && <SearchBox value={q} onChange={setQ} dark={dark} />}
          <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
            {allLabel && matches(allLabel, q) && (
              <Option dark={dark} selected={value === null} onClick={() => choose(null)}>
                {allLabel}
              </Option>
            )}
            {shown.map((c) => (
              <Option key={c.id} dark={dark} selected={c.id === value} onClick={() => choose(c.id)}>
                {c.name}
              </Option>
            ))}
            {shown.length === 0 && <li className={cn('px-3 py-2 text-sm', dark ? 'text-rail-ink' : 'text-ink-3')}>No client matches “{q}”.</li>}
          </ul>
          {clients.length > 6 && <p className={cn('border-t px-3 py-1.5 text-[11px]', dark ? 'border-rail-active text-rail-ink/80' : 'border-line text-ink-3')}>{clients.length} clients</p>}
        </div>
      )}
    </div>
  );
}

function Option({ children, selected, onClick, dark }: { children: ReactNode; selected: boolean; onClick: () => void; dark?: boolean }) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onClick}
        className={cn('flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm', dark ? 'text-rail-ink hover:bg-rail-active hover:text-white' : 'hover:bg-surface-2', selected && (dark ? 'text-white' : 'font-medium'))}
      >
        <span className="truncate">{children}</span>
        {selected && <Check className="h-4 w-4 shrink-0" aria-hidden />}
      </button>
    </li>
  );
}

/** Searchable multi-client picker with removable chips. */
export function ClientMultiSelect({ value, onChange, placeholder = 'Choose clients' }: { value: string[]; onChange: (ids: string[]) => void; placeholder?: string }) {
  const { clients } = useSession();
  const { open, setOpen, ref } = usePopover();
  const [q, setQ] = useState('');
  const shown = clients.filter((c) => matches(c.name, q));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  const names = (id: string) => clients.find((c) => c.id === id)?.name ?? 'Hidden client';

  return (
    <div ref={ref} className="relative space-y-2">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-9 w-full items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-left text-sm"
      >
        <span className={cn('truncate', !value.length && 'text-ink-3')}>{value.length ? `${value.length} client${value.length === 1 ? '' : 's'} selected` : placeholder}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
      </button>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-clearance-soft px-2 py-0.5 text-xs text-clearance">
              {names(id)}
              <button type="button" aria-label={`Remove ${names(id)}`} onClick={() => toggle(id)} className="rounded-full hover:bg-clearance/20">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface shadow-sm">
          <SearchBox value={q} onChange={setQ} />
          <div className="flex justify-between border-b border-line px-3 py-1.5 text-xs">
            <button type="button" className="text-clearance hover:underline" onClick={() => onChange([...new Set([...value, ...shown.map((c) => c.id)])])}>
              Select {q ? 'matching' : 'all'}
            </button>
            <button type="button" className="text-ink-3 hover:underline" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          <ul role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto py-1">
            {shown.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-2">
                  <input type="checkbox" checked={value.includes(c.id)} onChange={() => toggle(c.id)} />
                  <span className="truncate">{c.name}</span>
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">No client matches “{q}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
