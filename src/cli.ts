/**
 * Agent-ready CLI for the radar engine.
 *
 *   cli.ts                              run a cycle, print RadarArtifact to stdout
 *   cli.ts --out radar.json             write the artifact to a file
 *   cli.ts --in prev.json               thread the previous artifact (ledger history)
 *   cli.ts --now 2026-06-11T06:00:00Z   pin the clock for deterministic replay
 *   cli.ts --describe                   print the tool manifest and exit
 *
 * Contract: JSON-in / JSON-out on stdout. Errors are emitted as a single JSON
 * object on stderr with a non-zero exit code, so the agent layer can parse them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { runRadar } from './pipeline.ts';
import { describe } from './manifest.ts';
import { resolveNow } from './clock.ts';
import { assertCompatibleRadarArtifact } from './schema.ts';
import type { RadarArtifact } from './types.ts';

interface ParsedArgs {
  inPath: string | null;
  outPath: string | null;
  now: string | null;
  describe: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { inPath: null, outPath: null, now: null, describe: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--describe') parsed.describe = true;
    else if (a === '--in' && next) {
      parsed.inPath = next;
      i++;
    } else if (a === '--out' && next) {
      parsed.outPath = next;
      i++;
    } else if (a === '--now' && next) {
      parsed.now = next;
      i++;
    }
  }
  return parsed;
}

function emitError(message: string, detail?: unknown): never {
  const payload = { error: message, ...(detail !== undefined ? { detail: String(detail) } : {}) };
  process.stderr.write(JSON.stringify(payload) + '\n');
  process.exit(1);
}

function loadPrevious(path: string): RadarArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    emitError(
      `failed to read --in artifact from ${path}`,
      err instanceof Error ? err.message : err,
    );
  }
  try {
    const { artifact, warnings } = assertCompatibleRadarArtifact(raw);
    for (const w of warnings) process.stderr.write(`[warn] --in: ${w}\n`);
    return artifact;
  } catch (err) {
    emitError(`--in artifact failed schema gate`, err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.describe) {
    process.stdout.write(JSON.stringify(describe(), null, 2) + '\n');
    return;
  }

  const now = resolveNow(args.now ?? undefined);
  const previous = args.inPath ? loadPrevious(args.inPath) : null;

  process.stderr.write(`[ardur-radar-engine] starting cycle at ${now.toISOString()}\n`);
  const artifact = await runRadar({ now, env: process.env, previous });
  const json = JSON.stringify(artifact, null, 2);

  if (args.outPath) {
    writeFileSync(args.outPath, json, 'utf-8');
    process.stderr.write(`[ardur-radar-engine] wrote ${json.length} bytes → ${args.outPath}\n`);
  } else {
    process.stdout.write(json + '\n');
  }

  for (const w of artifact.warnings) process.stderr.write(`[warn] ${w}\n`);
}

main().catch((error: unknown) => {
  emitError('radar cycle failed', error instanceof Error ? (error.stack ?? error.message) : error);
});
