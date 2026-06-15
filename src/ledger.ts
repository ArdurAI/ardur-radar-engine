/**
 * Persisted rank-history ledger — ports `oss-radar-ledger.mjs`.
 *
 * Tracks every project that has ever entered the Top-10: first/last seen, a
 * sliding window of the last 40 rank snapshots, dropout timestamps, and article
 * status. The previous ledger is threaded in (from the prior radar artifact) so
 * history accumulates across cycles.
 */

import type { RankedSignal, LedgerSnapshot, LedgerProject, RankHistoryEntry } from './types.ts';

const HISTORY_WINDOW = 40;
export const DROPPED_PRUNE_AFTER_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Merge the current Top-10 into the prior ledger, returning the new ledger. */
export function updateLedger(
  topTen: RankedSignal[],
  previous: LedgerSnapshot | null,
  now: Date,
): LedgerSnapshot {
  const nowIso = now.toISOString();
  const projects: Record<string, LedgerProject> = {};

  // Carry forward existing entries (deep-ish copy of history arrays).
  for (const [id, prev] of Object.entries(previous?.projects ?? {})) {
    projects[id] = {
      ...prev,
      rankHistory: Array.isArray(prev.rankHistory) ? [...prev.rankHistory] : [],
    };
  }

  const activeIds = new Set<string>();

  for (const signal of topTen) {
    activeIds.add(signal.id);
    const existing = projects[signal.id];
    const entry: RankHistoryEntry = { rank: signal.rank, score: signal.score, seenAt: nowIso };
    const momentumStatus = signal.momentum?.status ?? 'proxy';

    if (existing) {
      const last = existing.rankHistory[existing.rankHistory.length - 1];
      if (!last || last.rank !== entry.rank || last.seenAt !== entry.seenAt) {
        existing.rankHistory.push(entry);
      }
      if (existing.rankHistory.length > HISTORY_WINDOW) {
        existing.rankHistory = existing.rankHistory.slice(-HISTORY_WINDOW);
      }
      existing.lastSeen = nowIso;
      existing.droppedAt = null;
      existing.latestScore = signal.score;
      existing.latestMomentumStatus = momentumStatus;
      existing.subtopic = signal.category;
      existing.subtopicLabel = signal.categoryLabel;
    } else {
      projects[signal.id] = {
        projectId: signal.id,
        fullName: signal.fullName,
        subtopic: signal.category,
        subtopicLabel: signal.categoryLabel,
        firstSeen: nowIso,
        lastSeen: nowIso,
        droppedAt: null,
        articleStatus: 'pending',
        rankHistory: [entry],
        latestScore: signal.score,
        latestMomentumStatus: momentumStatus,
      };
    }
  }

  // Mark dropouts: tracked projects no longer in the current Top-10.
  for (const project of Object.values(projects)) {
    if (!activeIds.has(project.projectId) && project.droppedAt === null) {
      project.droppedAt = nowIso;
    }
  }

  // Prune stale dropped entries to bound ledger growth (#17).
  for (const [id, project] of Object.entries(projects)) {
    if (project.droppedAt !== null && project.droppedAt !== undefined) {
      if (now.valueOf() - new Date(project.droppedAt).valueOf() > DROPPED_PRUNE_AFTER_MS) {
        delete projects[id];
      }
    }
  }

  const all = Object.values(projects);
  return {
    schemaVersion: 'oss-radar-ledger/v1',
    generatedAt: nowIso,
    generatedBy: 'deterministic-oss-radar-ledger-v1',
    projects,
    stats: {
      trackedCount: all.length,
      activeTopTenCount: activeIds.size,
      droppedCount: all.filter((p) => p.droppedAt !== null).length,
      articlePublishedCount: all.filter((p) => p.articleStatus === 'published').length,
    },
  };
}
