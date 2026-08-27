// Date filtering for the Released column. Pure functions, no React — the
// windowing rules live here so they can be unit-tested directly.

import type { CardDto } from '../../shared/api';

/**
 * Windows for the released-column date filter. Presets are calendar-day spans
 * ending today; 'custom' reads the From/To date inputs.
 */
export type ReleasedFilter = 'all' | 'today' | '7d' | '30d' | '90d' | 'custom';

export const RELEASED_FILTER_OPTIONS: { value: ReleasedFilter; label: string }[] = [
  { value: 'all', label: 'All Time' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: '90d', label: 'Last 90 Days' },
  { value: 'custom', label: 'Custom Range' },
];

/** Days covered by each preset, counting today as day one. */
const PRESET_DAYS: Record<Exclude<ReleasedFilter, 'all' | 'custom'>, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** The custom range's ends as yyyy-mm-dd date-input values; '' leaves an end open. */
export type ReleasedRange = { from: string; to: string };

/**
 * Local midnight of a date input's yyyy-mm-dd value. Parsed by hand because
 * `new Date('2026-08-27')` is specified as UTC midnight, which would shift the
 * range boundary by the timezone offset.
 */
function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return null;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Local midnight of the given moment. */
function startOfDay(moment: Date): Date {
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
}

/**
 * Whether `card` stays visible under the released-date filter. Only the
 * released column is date-filtered — cards in every other column always pass.
 * The timestamp is parsed the same way the drawer displays it
 * (`new Date(value)`), so what the filter keeps always agrees with the dates
 * on screen; a released card whose timestamp is missing or unreadable only
 * shows under 'all'.
 */
export function releasedCardVisible(
  card: Pick<CardDto, 'status' | 'completedAt'>,
  filter: ReleasedFilter,
  range: ReleasedRange,
  now: Date,
): boolean {
  if (card.status !== 'released' || filter === 'all') {
    return true;
  }
  if (card.completedAt === null) {
    return false;
  }
  const released = new Date(card.completedAt);
  if (Number.isNaN(released.getTime())) {
    return false;
  }

  if (filter === 'custom') {
    const from = parseDateInput(range.from);
    if (from !== null && released.getTime() < from.getTime()) {
      return false;
    }
    const to = parseDateInput(range.to);
    if (to !== null) {
      // The To day itself is included: the bound is the following midnight.
      const end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
      if (released.getTime() >= end.getTime()) {
        return false;
      }
    }
    return true;
  }

  const start = startOfDay(now);
  start.setDate(start.getDate() - (PRESET_DAYS[filter] - 1));
  return released.getTime() >= start.getTime();
}
