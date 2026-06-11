/**
 * Cycle host — wraps runRadar() with atomic output, manifest tracking, and
 * structured logs so the 6h cron (or ardur-pipeline) can drive the radar engine.
 *
 * Output layout under RADAR_OUTPUT_DIR (default: ./data/radar):
 *
 *   <outputDir>/latest/radar.json   ← current artifact (atomic rename)
 *   <outputDir>/manifest.json       ← last-good-wins pointer + stats
 *   <outputDir>/tmp/                ← staging area (cleaned up on success)
 *
 * The manifest is written ONLY after a successful artifact write, so it always
 * points to the last good artifact even if the current cycle fails mid-way.
 *
 * Structured log lines are emitted to stderr as JSON on a single line each:
 *   {"ts":"…","level":"info","event":"cycle.start","cycle":"…"}
 *   {"ts":"…","level":"info","event":"cycle.ok","durationMs":4200,"bytes":360000}
 *   {"ts":"…","level":"error","event":"cycle.fail","error":"…"}
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runRadar, type RunOptions } from './pipeline.ts';
import { resolveNow } from './clock.ts';
import { RADAR_SCHEMA_VERSION } from './contracts.ts';
import type { RadarArtifact } from './types.ts';
import type { CycleMeta } from './contracts.ts';

export const MANIFEST_SCHEMA_VERSION = 'ardur-radar-manifest/v1' as const;

export interface RadarManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  updatedAt: string;
  latestRunId: string;
  latestCycle: CycleMeta;
  latestPath: string;
  ok: boolean;
  warnings: string[];
  artifactBytes: number;
}

export interface CycleRunResult {
  ok: boolean;
  runId: string;
  cycle: CycleMeta;
  durationMs: number;
  artifactBytes: number;
  warnings: string[];
  errors: string[];
  outputDir: string;
}

export interface CycleHostOptions {
  /** Root directory for output. Defaults to RADAR_OUTPUT_DIR env, then ./data/radar. */
  outputDir?: string;
  /** ISO timestamp to pin (deterministic replay / testing). Defaults to real now. */
  now?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

function structuredLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  extra?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...extra,
  });
  process.stderr.write(line + '\n');
}

function loadPreviousArtifact(latestPath: string): RadarArtifact | null {
  if (!existsSync(latestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(latestPath, 'utf-8')) as Partial<RadarArtifact>;
    if (raw.schemaVersion !== RADAR_SCHEMA_VERSION || raw.artifact !== 'radar') return null;
    return raw as RadarArtifact;
  } catch {
    return null;
  }
}

/**
 * Run one radar cycle, write the artifact atomically, and update the manifest.
 *
 * Returns a CycleRunResult. On failure, rethrows the error after emitting a
 * structured error log — the caller (cron / ardur-pipeline) decides exit code.
 */
export async function runCycle(opts: CycleHostOptions = {}): Promise<CycleRunResult> {
  const env = opts.env ?? process.env;
  const outputDir = resolve(
    opts.outputDir ?? (env.RADAR_OUTPUT_DIR as string | undefined) ?? './data/radar',
  );
  const latestDir = join(outputDir, 'latest');
  const tmpDir = join(outputDir, 'tmp');
  const latestPath = join(latestDir, 'radar.json');
  const manifestPath = join(outputDir, 'manifest.json');

  mkdirSync(latestDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const now = resolveNow(opts.now);
  const previous = loadPreviousArtifact(latestPath);

  structuredLog('info', 'cycle.start', {
    cycle: now.toISOString(),
    outputDir,
    hasPrevious: previous !== null,
    previousRunId: previous?.runId,
  });

  const t0 = Date.now();

  const runOpts: RunOptions = {
    now,
    env,
    previous,
    fetchImpl: opts.fetchImpl ?? fetch,
  };

  let artifact: RadarArtifact;
  try {
    artifact = await runRadar(runOpts);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    structuredLog('error', 'cycle.fail', { error: message, durationMs: Date.now() - t0 });
    throw err;
  }

  const durationMs = Date.now() - t0;
  const json = JSON.stringify(artifact, null, 2);
  const artifactBytes = Buffer.byteLength(json, 'utf-8');

  // Atomic write: stage in tmp, then rename to latest.
  const tmpPath = join(tmpDir, `radar-${artifact.runId}.json`);
  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, latestPath);

  // Manifest: written only after successful artifact write (last-good-wins).
  const manifest: RadarManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    latestRunId: artifact.runId,
    latestCycle: artifact.cycle,
    latestPath: 'latest/radar.json',
    ok: true,
    warnings: artifact.warnings,
    artifactBytes,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  structuredLog('info', 'cycle.ok', {
    runId: artifact.runId,
    cycle: artifact.cycle.id,
    durationMs,
    artifactBytes,
    projectCount: artifact.data.projects.length,
    topTenCount: artifact.data.topTen.length,
    warnings: artifact.warnings.length,
    errors: artifact.data.errors.length,
  });

  if (artifact.warnings.length > 0) {
    for (const w of artifact.warnings) {
      structuredLog('warn', 'cycle.warning', { message: w });
    }
  }

  return {
    ok: true,
    runId: artifact.runId,
    cycle: artifact.cycle,
    durationMs,
    artifactBytes,
    warnings: artifact.warnings,
    errors: artifact.data.errors,
    outputDir,
  };
}
