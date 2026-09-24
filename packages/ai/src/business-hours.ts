export type BusinessHoursConfig = Partial<Record<'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday', { start: string; end: string }[]>>;

type Weekday = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

/** Local weekday and HH:MM for an instant in an IANA timezone. */
export function localTime(date: Date, timezone: string): { day: Weekday; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday').toLowerCase() as Weekday;
  return { day, hhmm: `${get('hour').padStart(2, '0')}:${get('minute')}` };
}

/**
 * True when `date` falls inside the configured hours in the client's timezone.
 * An empty configuration means "always open".
 */
export function isWithinBusinessHours(hours: BusinessHoursConfig | null | undefined, timezone: string, date = new Date()): boolean {
  if (!hours || Object.keys(hours).length === 0) return true;
  const { day, hhmm } = localTime(date, timezone);
  return (hours[day] ?? []).some((r) => hhmm >= r.start && hhmm < r.end);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
