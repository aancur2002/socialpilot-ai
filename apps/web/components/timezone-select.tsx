'use client';

import { useMemo, useState } from 'react';
import { Input, Select } from './ui/primitives';

const FALLBACK = ['UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

/** Browsers (ICU) still list some zones under legacy names; show the current IANA name instead. */
const MODERN_NAMES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
};
const LEGACY_NAMES = Object.fromEntries(Object.entries(MODERN_NAMES).map(([legacy, modern]) => [modern, legacy]));

function allTimezones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (zones?.length) {
      const modern = [...new Set(zones.map((z) => MODERN_NAMES[z] ?? z))];
      return modern.includes('UTC') ? modern : ['UTC', ...modern];
    }
  } catch {
    /* older browsers */
  }
  return FALLBACK;
}

/** Current UTC offset for a zone, e.g. "UTC+05:30". */
function offsetLabel(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
    return part === 'GMT' ? 'UTC+00:00' : (part ?? '').replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

interface ZoneOption {
  zone: string;
  label: string;
  region: string;
  /** Extra search terms (legacy names) */
  aliases: string;
}

/**
 * Timezone picker: searchable, grouped by region, with each zone's current
 * offset. Values are IANA names (e.g. "Asia/Kolkata"), as the API expects.
 */
export function TimezoneSelect({ id, value, onChange, disabled }: { id: string; value: string; onChange: (tz: string) => void; disabled?: boolean }) {
  const [query, setQuery] = useState('');
  const options = useMemo<ZoneOption[]>(
    () =>
      allTimezones().map((zone) => {
        const [region, ...rest] = zone.split('/');
        const city = rest.length ? rest.join(' / ').replace(/_/g, ' ') : zone;
        return { zone, region: rest.length ? region! : 'Other', label: `${city} (${offsetLabel(zone)})`, aliases: (LEGACY_NAMES[zone] ?? '').toLowerCase() };
      }),
    [],
  );
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.zone.toLowerCase().includes(q) || o.label.toLowerCase().includes(q) || o.aliases.includes(q)) : options;
  // Keep the current value selectable even when filtered out (including legacy saved values).
  const current = options.find((o) => o.zone === value) ?? { zone: value, region: 'Current', label: value, aliases: '' };
  const visible = filtered.some((o) => o.zone === value) ? filtered : [current, ...filtered];
  const groups = visible.reduce<Record<string, ZoneOption[]>>((acc, o) => {
    (acc[o.region] ??= []).push(o);
    return acc;
  }, {});

  return (
    <div className="space-y-1.5">
      <Input aria-label="Search timezones" placeholder="Search city or region, e.g. Kolkata" value={query} disabled={disabled} onChange={(e) => setQuery(e.target.value)} />
      <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {Object.entries(groups).map(([region, zones]) => (
          <optgroup key={region} label={region}>
            {zones.map((o) => (
              <option key={o.zone} value={o.zone}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      {q && filtered.length > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-[var(--radius-control)] border border-line bg-surface" aria-label="Matching timezones">
          {filtered.slice(0, 12).map((o) => (
            <li key={o.zone}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                onClick={() => {
                  onChange(o.zone);
                  setQuery('');
                }}
              >
                <span>{o.label}</span>
                <span className="text-xs text-ink-3">{o.zone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q && filtered.length === 0 && <p className="text-xs text-ink-3">No timezone matches “{query}”.</p>}
    </div>
  );
}

export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
