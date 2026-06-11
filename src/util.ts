/**
 * Small deterministic helpers shared across the radar pipeline. Everything here
 * is pure and side-effect free except `boundedFetch`, which is the single seam
 * the engine uses to reach the network (and is never called on the default,
 * deterministic path).
 */

import { createHash } from 'node:crypto';

/** Clamp `value` into the inclusive range [0, max]. */
export function clamp(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}

/** log10(value + 1), guarded against negatives. Mirrors the in-ardur.ai scoring. */
export function log10p1(value: number): number {
  return Math.log10(Math.max(0, value) + 1);
}

/** Age of an ISO timestamp in whole-ish days relative to `now` (never negative). */
export function ageDays(iso: string | null | undefined, now: Date): number {
  const ms = iso ? new Date(iso).valueOf() : 0;
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.valueOf() - ms) / 86_400_000);
}

/** Stable, content-addressed node id: `<prefix>:<10-char base64url sha256>`. */
export function stableId(prefix: string, value: string): string {
  const hash = createHash('sha256').update(String(value)).digest('base64url').slice(0, 10);
  return `${prefix}:${hash}`;
}

/** De-duplicate while preserving first-seen order. */
export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Read a fetch Response body with a hard byte ceiling. Throws if exceeded. */
export async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeded ${maxBytes} byte ceiling`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Env truthiness: only '1' / 'true' enable a flag. */
export function envFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = env[key];
  return v === '1' || v === 'true';
}

/** Parse an int env var with a default. */
export function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
