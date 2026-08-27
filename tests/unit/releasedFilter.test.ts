import { describe, expect, it } from 'vitest';

import { releasedCardVisible, type ReleasedFilter, type ReleasedRange } from '../../src/renderer/src/releasedFilter';

// Wednesday 2026-08-27, mid-afternoon local time.
const NOW = new Date(2026, 7, 27, 15, 30, 0);
const OPEN: ReleasedRange = { from: '', to: '' };

function released(completedAt: string | null) {
  return { status: 'released' as const, completedAt };
}

function visible(completedAt: string | null, filter: ReleasedFilter, range: ReleasedRange = OPEN): boolean {
  return releasedCardVisible(released(completedAt), filter, range, NOW);
}

describe('releasedCardVisible', () => {
  it('never filters cards outside the released column', () => {
    const card = { status: 'backlog' as const, completedAt: null };
    expect(releasedCardVisible(card, 'today', OPEN, NOW)).toBe(true);
    expect(releasedCardVisible(card, 'custom', { from: '2026-08-01', to: '2026-08-02' }, NOW)).toBe(true);
  });

  it("passes everything under 'all', including a missing timestamp", () => {
    expect(visible(null, 'all')).toBe(true);
    expect(visible('2001-01-01 00:00:00', 'all')).toBe(true);
  });

  it('hides released cards with a missing or unreadable timestamp from any window', () => {
    expect(visible(null, 'today')).toBe(false);
    expect(visible('not a date', 'today')).toBe(false);
    expect(visible(null, 'custom')).toBe(false);
  });

  it("'today' keeps releases since local midnight and drops yesterday's", () => {
    expect(visible('2026-08-27 00:00:00', 'today')).toBe(true);
    expect(visible('2026-08-27 08:15:00', 'today')).toBe(true);
    expect(visible('2026-08-26 23:59:59', 'today')).toBe(false);
  });

  it('day presets span whole calendar days, counting today as day one', () => {
    // 7 days ending today start at midnight 2026-08-21.
    expect(visible('2026-08-21 00:00:00', '7d')).toBe(true);
    expect(visible('2026-08-20 23:59:59', '7d')).toBe(false);
    // 30 days ending today start at midnight 2026-07-29.
    expect(visible('2026-07-29 00:00:00', '30d')).toBe(true);
    expect(visible('2026-07-28 23:59:59', '30d')).toBe(false);
    // 90 days ending today start at midnight 2026-05-30.
    expect(visible('2026-05-30 00:00:00', '90d')).toBe(true);
    expect(visible('2026-05-29 23:59:59', '90d')).toBe(false);
  });

  it('custom range includes both end days', () => {
    const range = { from: '2026-08-01', to: '2026-08-15' };
    expect(visible('2026-08-01 00:00:00', 'custom', range)).toBe(true);
    expect(visible('2026-08-15 23:59:59', 'custom', range)).toBe(true);
    expect(visible('2026-07-31 23:59:59', 'custom', range)).toBe(false);
    expect(visible('2026-08-16 00:00:00', 'custom', range)).toBe(false);
  });

  it('custom range treats an empty end as open', () => {
    expect(visible('2001-01-01 00:00:00', 'custom', { from: '', to: '2026-01-01' })).toBe(true);
    expect(visible('2026-01-02 00:00:00', 'custom', { from: '', to: '2026-01-01' })).toBe(false);
    expect(visible('2099-01-01 00:00:00', 'custom', { from: '2026-01-01', to: '' })).toBe(true);
    expect(visible('2025-12-31 23:59:59', 'custom', { from: '2026-01-01', to: '' })).toBe(false);
    // Both ends empty: no restriction yet — show everything dated.
    expect(visible('2001-01-01 00:00:00', 'custom', OPEN)).toBe(true);
  });
});
