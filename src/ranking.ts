/**
 * Top-10 OSS ranking — ports `oss-ranking.mjs`.
 *
 * Blends four weighted components into a single 0–100 score:
 *   GitHub adoption (35) + cross-platform momentum (25) + recency (20) + credibility (20)
 * then applies two integrity caps: missing SPDX license caps at 82, and a
 * watch-confidence project caps at 78. The top 10 are returned, ranked 1..10.
 */

import type { RadarProject, RankedSignal, MomentumSnapshot, ScoreBreakdown } from './types.ts';
import { clamp, log10p1, ageDays } from './util.ts';
import { lookupMomentum } from './momentum.ts';

export const WEIGHT_CONFIG = {
  id: 'oss-ranking-v1',
  githubAdoption: 35,
  crossPlatformMomentum: 25,
  recency: 20,
  credibility: 20,
} as const;

export function scoreGithubAdoption(project: RadarProject): number {
  const licenseKnown = Boolean(project.license);
  return clamp(
    Math.min(22, log10p1(project.stars) * 8) +
      Math.min(8, log10p1(project.forks) * 4) +
      (licenseKnown ? 5 : 0),
    WEIGHT_CONFIG.githubAdoption,
  );
}

export function scoreCrossPlatformMomentum(
  project: RadarProject,
  momentum: MomentumSnapshot,
): number {
  const m = lookupMomentum(project.id, momentum);
  const raw = m?.score ?? 0;
  const maxRaw = 45;
  return clamp(
    (raw / maxRaw) * WEIGHT_CONFIG.crossPlatformMomentum,
    WEIGHT_CONFIG.crossPlatformMomentum,
  );
}

export function scoreRecency(project: RadarProject, now: Date): number {
  const age = ageDays(project.pushedAt, now);
  if (age <= 7) return 20;
  if (age <= 30) return 16;
  if (age <= 90) return 10;
  if (age <= 180) return 5;
  return 2;
}

export function scoreCredibility(project: RadarProject): number {
  const confidence = project.rankingConfidence.level;
  let score = Math.min(8, project.sourceCount * 4) + Math.min(6, project.topics.length);
  if (confidence === 'high') score += 6;
  else if (confidence === 'medium') score += 3;
  return clamp(score, WEIGHT_CONFIG.credibility);
}

function scoreProject(
  project: RadarProject,
  momentum: MomentumSnapshot,
  now: Date,
): { breakdown: ScoreBreakdown; rationale: string } {
  const githubAdoption = scoreGithubAdoption(project);
  const crossPlatformMomentum = scoreCrossPlatformMomentum(project, momentum);
  const recency = scoreRecency(project, now);
  const credibility = scoreCredibility(project);
  const totalBeforeAdjustments = githubAdoption + crossPlatformMomentum + recency + credibility;

  let finalScore = totalBeforeAdjustments;
  const adjustments: string[] = [];
  if (!project.license) {
    finalScore = Math.min(finalScore, 82);
    adjustments.push('missing SPDX license metadata caps final score at 82');
  }
  if (project.rankingConfidence.level === 'watch') {
    finalScore = Math.min(finalScore, 78);
    adjustments.push('watchlist confidence keeps the project below top-tier promotion (cap 78)');
  }
  finalScore = clamp(finalScore, 100);

  const breakdown: ScoreBreakdown = {
    weightConfigId: WEIGHT_CONFIG.id,
    githubAdoption,
    crossPlatformMomentum,
    recency,
    credibility,
    totalBeforeAdjustments,
    finalScore,
    adjustments,
  };
  const rationale = `Ranked from GitHub adoption (${githubAdoption.toFixed(0)}/35), chatter momentum (${crossPlatformMomentum.toFixed(0)}/25), recency (${recency.toFixed(0)}/20), and credibility (${credibility.toFixed(0)}/20).`;
  return { breakdown, rationale };
}

/**
 * Rank projects and return the top `limit` (default 10) as `RankedSignal`s.
 * Sort is score DESC, then fullName ASC for a stable tiebreak.
 */
export function rankTopSignals(
  projects: RadarProject[],
  momentum: MomentumSnapshot,
  now: Date,
  limit = 10,
): RankedSignal[] {
  const scored = projects.map((project) => {
    const { breakdown, rationale } = scoreProject(project, momentum, now);
    return {
      ...project,
      score: breakdown.finalScore,
      scoreBreakdown: breakdown,
      momentum: lookupMomentum(project.id, momentum),
      rankingRationale: rationale,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName));
  return scored.slice(0, limit).map((signal, i) => ({ ...signal, rank: i + 1 }));
}
