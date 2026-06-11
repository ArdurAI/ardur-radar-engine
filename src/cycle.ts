/**
 * Cycle runner — standalone entry point for cron / ardur-pipeline.
 *
 *   node --experimental-strip-types src/cycle.ts
 *
 * Reads RADAR_OUTPUT_DIR from the environment (default: ./data/radar).
 * Exits 0 on success, 1 on failure.  All structured logs go to stderr as
 * newline-delimited JSON so the host can parse them.
 */

import { runCycle } from './cycle-host.ts';

runCycle()
  .then((result) => {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        event: 'cycle.summary',
        runId: result.runId,
        durationMs: result.durationMs,
        artifactBytes: result.artifactBytes,
        warnings: result.warnings.length,
        errors: result.errors.length,
        outputDir: result.outputDir,
      }) + '\n',
    );
    process.exit(0);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'cycle.fatal',
        error: message,
      }) + '\n',
    );
    process.exit(1);
  });
