/**
 * RadarArtifact schema gate — mirrors the @ardurai/contracts assertCompatibleArtifact
 * pattern for the radar-specific schema version.
 *
 * Run assertCompatibleRadarArtifact(raw) on every inbound artifact BEFORE
 * casting to RadarArtifact. This is the GATE-BEFORE-USE equivalent for radar.
 *
 * Usage:
 *   const { artifact, warnings } = assertCompatibleRadarArtifact(JSON.parse(raw));
 *   for (const w of warnings) console.warn(w);
 *   // artifact is now safely typed as RadarArtifact
 */

import { SchemaVersionError } from './contracts.ts';
import { RADAR_SCHEMA_VERSION, CONTRACT_REVISION } from './contracts.ts';
import type { RadarArtifact } from './types.ts';

export interface RadarGateResult {
  artifact: RadarArtifact;
  warnings: string[];
}

/**
 * Throws SchemaVersionError when:
 *   - raw is not an object / is null
 *   - raw.schemaVersion !== 'ardur-radar/v1'  (wrong engine — hard fail)
 *   - raw.artifact !== 'radar'                (wrong artifact type — hard fail)
 *   - raw.data is missing or not a non-null object
 *   - raw.data.projects / topTen / ledger / signalMap / writeups are not arrays
 *
 * Returns non-fatal warnings when:
 *   - raw.contractRevision > CONTRACT_REVISION (forward-compat: additive fields ignored)
 *   - raw.contractRevision < CONTRACT_REVISION (backward-compat: older engine)
 */
export function assertCompatibleRadarArtifact(raw: unknown): RadarGateResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new SchemaVersionError({
      expected: RADAR_SCHEMA_VERSION,
      received: raw,
      stage: 'radar',
    });
  }

  const env = raw as Record<string, unknown>;

  if (env['schemaVersion'] !== RADAR_SCHEMA_VERSION) {
    throw new SchemaVersionError({
      expected: RADAR_SCHEMA_VERSION,
      received: env['schemaVersion'],
      stage: 'radar',
    });
  }

  if (env['artifact'] !== 'radar') {
    throw new SchemaVersionError({
      expected: 'artifact=radar',
      received: env['artifact'],
      stage: 'radar',
    });
  }

  if (typeof env['data'] !== 'object' || env['data'] === null) {
    throw new SchemaVersionError({
      expected: 'non-null object at .data',
      received: env['data'],
      stage: 'radar',
    });
  }

  const data = env['data'] as Record<string, unknown>;
  const warnings: string[] = [];

  // Structural checks on required RadarData fields.
  for (const field of ['projects', 'topTen', 'writeups', 'errors'] as const) {
    if (!Array.isArray(data[field])) {
      throw new SchemaVersionError({
        expected: `array at .data.${field}`,
        received: data[field],
        stage: 'radar',
      });
    }
  }

  // Ledger + signalMap must be non-null objects (they may be empty).
  for (const field of ['ledger', 'signalMap'] as const) {
    if (typeof data[field] !== 'object' || data[field] === null) {
      throw new SchemaVersionError({
        expected: `non-null object at .data.${field}`,
        received: data[field],
        stage: 'radar',
      });
    }
  }

  // Contract revision warnings (non-fatal).
  const rev = typeof env['contractRevision'] === 'number' ? env['contractRevision'] : 1;
  if (rev > CONTRACT_REVISION) {
    warnings.push(
      `upstream contractRevision ${rev} > local ${CONTRACT_REVISION}; ` +
        `additive fields may be ignored (forward-compatible)`,
    );
  } else if (rev < CONTRACT_REVISION) {
    warnings.push(
      `upstream contractRevision ${rev} < local ${CONTRACT_REVISION}; ` +
        `artifact may be missing newer fields (backward-compatible)`,
    );
  }

  return { artifact: raw as RadarArtifact, warnings };
}
