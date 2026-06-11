/**
 * Radar pipeline orchestrator — holds the WHOLE Radar pipeline in one process:
 *
 *   ingest (GitHub + chatter) → momentum → Top-10 ranking → ledger → signal map → writeups
 *
 * Produces a single versioned `RadarArtifact` that ardur.ai's /radar consumes
 * (mirroring the news pipeline's manifest + latest/ handoff). Everything is
 * deterministic given `(now, env, previous)`; the default path makes no network
 * calls and still emits a complete, valid artifact.
 */

import { CONTRACT_REVISION, RADAR_SCHEMA_VERSION } from './contracts.ts';
import type { RadarArtifact, RadarData, RadarRunContext, RadarProject } from './types.ts';
import { stableId } from './util.ts';
import { cycleFor } from './clock.ts';
import { RADAR_CATEGORIES, ingestProjects, githubLiveEnabled } from './ingest/github.ts';
import { chatterLiveEnabled } from './ingest/chatter.ts';
import { buildMomentumSnapshot } from './momentum.ts';
import { rankTopSignals } from './ranking.ts';
import { updateLedger } from './ledger.ts';
import { buildSignalMap } from './signal-map.ts';
import { createProvider } from './writeup/provider.ts';
import { synthesizeWriteups } from './writeup/synthesize.ts';
import { enrichProjects } from './ingest/github-enrich.ts';

export interface RunOptions {
  now: Date;
  env?: NodeJS.ProcessEnv;
  previous?: RadarArtifact | null;
  fetchImpl?: typeof fetch;
  /** Seed projects (e.g. from a prior artifact) when GitHub ingestion is offline. */
  seedProjects?: RadarProject[];
}

/** Run the full radar pipeline and assemble the artifact. */
export async function runRadar(options: RunOptions): Promise<RadarArtifact> {
  const now = options.now;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const previous = options.previous ?? null;

  const cycle = cycleFor(now);
  const ctx: RadarRunContext = { now, cycle, env, previous, fetchImpl };
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. Ingest — live GitHub Search when enabled, else seed/previous projects.
  const ingest = await ingestProjects(RADAR_CATEGORIES, env, fetchImpl, now);
  errors.push(...ingest.errors);
  let projects = ingest.projects;
  if (projects.length === 0) {
    const seed = options.seedProjects ?? previous?.data.projects ?? [];
    if (seed.length > 0) {
      projects = seed.map((p, i) => ({ ...p, rank: i + 1 }));
      warnings.push(`github ingestion empty — reused ${seed.length} seed projects`);
    } else {
      warnings.push('github ingestion empty and no seed projects — radar cycle is empty');
    }
  }

  // 2. Momentum (GitHub activity + opt-in chatter).
  const momentum = await buildMomentumSnapshot(projects, env, fetchImpl, now, cycle.id);

  // 3. Top-10 ranking.
  const topTen = rankTopSignals(projects, momentum, now, 10);

  // 4. Ledger (rank history / dropout), threaded from the previous artifact.
  const ledger = updateLedger(topTen, previous?.data.ledger ?? null, now);

  // 5. Signal map.
  const signalMap = buildSignalMap(topTen, momentum, now);

  // 6. Enrichment (opt-in: latest release + README excerpt for Top-10 projects).
  const enrichments = await enrichProjects(
    topTen.map((p) => p.fullName),
    env,
    fetchImpl,
  );

  // 7. Writeups (fact-grounded, AI-primary, HOLD on failure).
  const provider = createProvider({ now, env, fetchImpl });
  const writeups = await synthesizeWriteups(topTen, provider, now, enrichments);

  const data: RadarData = {
    source:
      'GitHub Search API allow-listed open-source topic queries + opt-in cross-platform chatter',
    policy: {
      github: githubLiveEnabled(env)
        ? 'live GitHub Search (authenticated or opt-in)'
        : 'offline — deterministic seed/previous projects',
      ai: `provider=${provider.name}; held when AI-unavailable or ungrounded`,
      ranking:
        'oss-ranking-v1: adoption 35 / momentum 25 / recency 20 / credibility 20, license & watch caps',
      chatterFetchMode: chatterLiveEnabled(env) ? 'opt-in-network' : 'deterministic-no-network',
    },
    categories: RADAR_CATEGORIES,
    coverage: ingest.coverage,
    projects,
    topTen,
    momentum,
    ledger,
    signalMap,
    writeups,
    errors,
  };

  void ctx; // ctx is the threaded run context; reserved for future stage injection.

  return {
    schemaVersion: RADAR_SCHEMA_VERSION,
    contractRevision: CONTRACT_REVISION,
    artifact: 'radar',
    runId: stableId('run', `${cycle.id}:${now.toISOString()}`),
    generatedAt: now.toISOString(),
    cycle,
    warnings,
    data,
  };
}
