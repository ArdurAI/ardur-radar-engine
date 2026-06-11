/**
 * Deterministic clock. Every stage takes `now` explicitly so a run is fully
 * reproducible from `--now <iso>` (or a pinned cycle), and so wall-clock never
 * leaks into scoring. No module calls `Date.now()` or `new Date()` directly.
 */

import type { CycleMeta } from './contracts.ts';

export const CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Resolve the engine clock from a CLI `--now` value (or the real clock). */
export function resolveNow(iso?: string | undefined): Date {
  if (iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.valueOf())) {
      throw new Error(`invalid --now value: ${iso}`);
    }
    return d;
  }
  return new Date();
}

/** UTC-aligned 6-hour cycle window containing `now` (00:00 / 06:00 / 12:00 / 18:00). */
export function cycleFor(now: Date): CycleMeta {
  const floored = Math.floor(now.valueOf() / CYCLE_INTERVAL_MS) * CYCLE_INTERVAL_MS;
  const start = new Date(floored);
  const end = new Date(floored + CYCLE_INTERVAL_MS);
  return {
    id: start.toISOString(),
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
}
