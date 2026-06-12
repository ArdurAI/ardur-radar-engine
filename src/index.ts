/**
 * @ardurai/radar-engine — public API.
 *
 * The standalone OSS RADAR engine for ardur.ai. Importable as a library (run the
 * pipeline, reuse the scoring functions) or runnable as an agent-ready CLI
 * (`src/cli.ts`). Consumes `@ardurai/contracts` Rev 3 for shared primitives.
 */

export * from './types.ts';
export { RADAR_SCHEMA_VERSION, CONTRACT_REVISION, type RadarEnvelope } from './contracts.ts';
export { safePublicUrl } from './util.ts';

// Pipeline
export { runRadar, type RunOptions } from './pipeline.ts';
export { cycleFor, resolveNow, CYCLE_INTERVAL_MS } from './clock.ts';

// Ingestion
export {
  RADAR_CATEGORIES,
  ingestProjects,
  repoScore,
  computeConfidence,
  githubLiveEnabled,
} from './ingest/github.ts';
export { collectChatter, searchTermsFor, chatterLiveEnabled } from './ingest/chatter.ts';
export {
  enrichProject,
  enrichProjects,
  enrichmentEnabled,
  type ProjectEnrichment,
  type ReleaseEnrichment,
} from './ingest/github-enrich.ts';

// Scoring core
export {
  buildMomentumSnapshot,
  githubMomentum,
  momentumForProject,
  lookupMomentum,
} from './momentum.ts';
export {
  rankTopSignals,
  scoreGithubAdoption,
  scoreCrossPlatformMomentum,
  scoreRecency,
  scoreCredibility,
  WEIGHT_CONFIG,
} from './ranking.ts';
export { updateLedger } from './ledger.ts';
export { buildSignalMap } from './signal-map.ts';

// Writeups
export {
  createProvider,
  buildPrompt,
  type AiProvider,
  type ProviderName,
} from './writeup/provider.ts';
export { synthesizeWriteup, synthesizeWriteups, deriveFacts } from './writeup/synthesize.ts';
export {
  buildProvenanceFromFacts,
  enforceCopyright,
  extractInlineCitations,
  countWords,
  MAX_QUOTE_WORDS,
} from './writeup/copyright.ts';

// Agent-readiness
export { describe, type ToolManifest } from './manifest.ts';

// Schema gate
export { assertCompatibleRadarArtifact, type RadarGateResult } from './schema.ts';

// Cycle host (6h cron orchestration)
export {
  runCycle,
  type CycleRunResult,
  type CycleHostOptions,
  type RadarManifest,
  MANIFEST_SCHEMA_VERSION,
} from './cycle-host.ts';
