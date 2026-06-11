/**
 * Contract surface for the radar engine.
 *
 * The radar engine is scoped to the Radar section only, but it shares the
 * Ardur content-pipeline primitives so that provenance, provider metadata, and
 * cycle semantics are byte-identical to the news engine family. We re-export the
 * primitives we reuse from `@ardurai/contracts` (Rev 3) and define the
 * radar-specific envelope locally — radar is a *parallel* pipeline, not a stage
 * of the four-engine content chain, so it carries its own `schemaVersion`.
 */

export {
  SCHEMA_VERSION as CONTENT_SCHEMA_VERSION,
  CONTRACT_REVISION,
  SchemaVersionError,
  assertCompatibleArtifact,
} from '@ardurai/contracts';

export type {
  Confidence,
  CycleMeta,
  ProviderMeta,
  SourceTier,
  SourceRef,
  ExtractedFact,
  FactProvenance,
  ClaimProvenance,
} from '@ardurai/contracts';

/** Wire identifier for radar artifacts. Independent of the content-pipeline schema. */
export const RADAR_SCHEMA_VERSION = 'ardur-radar/v1' as const;

/**
 * Versioned envelope wrapping a radar cycle. Mirrors the content-pipeline
 * `ArtifactEnvelope` shape (so the agent layer and ardur.ai can read it with the
 * same machinery) but is radar-scoped.
 */
export interface RadarEnvelope<TData> {
  schemaVersion: typeof RADAR_SCHEMA_VERSION;
  /** CONTRACT_REVISION of `@ardurai/contracts` this build consumes. */
  contractRevision: number;
  artifact: 'radar';
  runId: string;
  generatedAt: string; // ISO 8601 UTC
  cycle: import('@ardurai/contracts').CycleMeta;
  warnings: string[];
  data: TData;
}
