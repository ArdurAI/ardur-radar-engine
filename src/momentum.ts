/**
 * Momentum scoring — ports `oss-momentum-signals.mjs`.
 *
 * Per project: GitHub activity momentum (0–25) + cross-platform chatter (0–90,
 * but the combined total is clamped to 45) + a diversity bonus of 2 points per
 * unique "real" platform (max 10). The combined score is clamped to 45.
 */

import type {
  RadarProject,
  ChatterResult,
  MomentumForProject,
  MomentumSnapshot,
  ChatterPlatform,
} from './types.ts';
import { clamp, log10p1, ageDays } from './util.ts';
import { collectChatter, chatterLiveEnabled } from './ingest/chatter.ts';

const MOMENTUM_MAX = 45;

const ALLOWED_PLATFORMS: ChatterPlatform[] = [
  'hacker-news',
  'reddit',
  'devto',
  'medium',
  'youtube',
  'x-stub',
  'github-metadata',
];

/** GitHub activity momentum (0–25) — ported from the in-ardur.ai formula. */
export function githubMomentum(project: RadarProject, now: Date): number {
  let score = Math.min(18, log10p1(project.stars) * 5) + Math.min(8, log10p1(project.forks) * 3);
  const age = ageDays(project.pushedAt, now);
  if (age <= 14) score += 8;
  else if (age <= 45) score += 5;
  else if (age <= 120) score += 2;
  return clamp(score, 25);
}

/** Combine GitHub + chatter + diversity into a single 0–45 momentum signal. */
export function momentumForProject(
  project: RadarProject,
  chatter: ChatterResult,
  now: Date,
): MomentumForProject {
  const github = githubMomentum(project, now);
  const realPlatforms = chatter.platforms.filter((p) => p.status === 'real').length;
  const diversityBonus = Math.min(10, realPlatforms * 2);
  const score = clamp(github + chatter.score + diversityBonus, MOMENTUM_MAX);
  const realMetrics = [
    {
      type: 'github_metadata',
      stars: project.stars,
      forks: project.forks,
      pushedAt: project.pushedAt,
    },
    ...chatter.realMetrics,
  ];
  return {
    projectId: project.id,
    score,
    status: chatter.status === 'real' ? 'real' : 'proxy',
    signals: [`GitHub activity momentum ${github.toFixed(1)}/25`, ...chatter.signals.slice(0, 4)],
    realMetrics,
    unavailableMetrics: chatter.unavailableMetrics,
    components: { github, chatter: chatter.score, diversityBonus },
  };
}

/** Build the momentum snapshot for all tracked projects. */
export async function buildMomentumSnapshot(
  projects: RadarProject[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  now: Date,
  sourceSnapshotGeneratedAt: string,
): Promise<MomentumSnapshot> {
  const byProjectId: Record<string, MomentumForProject> = {};
  let realCount = 0;
  let unavailableCount = 0;
  for (const project of projects) {
    const chatter = await collectChatter(project, env, fetchImpl);
    const momentum = momentumForProject(project, chatter, now);
    byProjectId[project.id] = momentum;
    if (momentum.status === 'real') realCount++;
    unavailableCount += momentum.unavailableMetrics.length;
  }
  return {
    schemaVersion: 'oss-momentum/v1',
    generatedAt: now.toISOString(),
    generatedBy: 'deterministic-oss-momentum-v1',
    sourceSnapshotGeneratedAt,
    policy: {
      fetchMode: chatterLiveEnabled(env) ? 'opt-in-network' : 'deterministic-no-network',
      allowedPlatforms: ALLOWED_PLATFORMS,
      unavailableMetricPlaceholder: '[FILL: platform chatter unavailable]',
    },
    stats: {
      projectCount: projects.length,
      realMetricCount: realCount,
      unavailableMetricCount: unavailableCount,
    },
    lookup: { byProjectId },
  };
}

/** Look up a project's momentum (by project id). */
export function lookupMomentum(
  projectId: string,
  snapshot: MomentumSnapshot,
): MomentumForProject | null {
  return snapshot.lookup.byProjectId[projectId] ?? null;
}
