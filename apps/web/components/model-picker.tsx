'use client';

import { ListRestart } from 'lucide-react';
import { useState } from 'react';
import { Input } from './ui/primitives';

/** Models that write long hidden "thinking" before answering: slower and more tokens. */
const REASONING = /reason|thinking|-r1\b|deepseek-r|qwq|o\d-|glm-5|kimi|gpt-oss/i;

/**
 * Model field: type any ID, or load the provider's live list and pick from it.
 * The list is a real, visible dropdown (with a filter), not a hidden datalist.
 */
export function ModelPicker({
  id,
  value,
  onChange,
  placeholder,
  models,
  loading,
  onLoad,
  purpose = 'text',
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Live models from the provider (undefined until loaded) */
  models?: string[];
  loading?: boolean;
  onLoad: () => void;
  purpose?: 'text' | 'embedding';
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const shown = (models ?? []).filter((m) => !q || m.toLowerCase().includes(q));

  return (
    <div className="space-y-1.5">
      <Input id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs font-medium text-clearance hover:underline disabled:opacity-50"
          disabled={loading}
          onClick={() => {
            if (models) setOpen((o) => !o);
            else {
              onLoad();
              setOpen(true);
            }
          }}
        >
          <ListRestart className="h-3.5 w-3.5" />
          {loading ? 'Loading models…' : models ? (open ? 'Hide model list' : `Choose from ${models.length} models`) : 'Load models from provider'}
        </button>
        {models && (
          <button type="button" className="text-xs text-ink-3 hover:underline" onClick={onLoad} disabled={loading}>
            Reload
          </button>
        )}
      </div>
      {open && models && (
        <div className="rounded-[var(--radius-control)] border border-line bg-surface">
          <div className="border-b border-line p-2">
            <Input aria-label="Filter models" placeholder={purpose === 'embedding' ? 'Filter, e.g. embed' : 'Filter, e.g. flash, lite, nano, 8b'} value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8" />
          </div>
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-3">{models.length ? 'No model matches that filter.' : 'The provider returned no models for this key.'}</p>
          ) : (
            <ul className="max-h-56 overflow-y-auto py-1" role="listbox" aria-label="Available models">
              {shown.map((m) => (
                <li key={m}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={m === value}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-surface-2 ${m === value ? 'bg-clearance-soft font-medium' : ''}`}
                    onClick={() => {
                      onChange(m);
                      setOpen(false);
                      setFilter('');
                    }}
                  >
                    <span className="truncate">{m}</span>
                    {purpose === 'text' && REASONING.test(m) && <span className="shrink-0 text-[11px] text-runway">reasoning, slower</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
