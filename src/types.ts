/**
 * Radar domain types. These are a faithful TypeScript port of the data shapes
 * the proven in-ardur.ai OSS RADAR scripts persist today (openSourceRadarSnapshot,
 * ossMomentumSnapshot, ossRadarLedgerSnapshot, ossSignalMapExportSnapshot) plus
 * the new fact-grounded writeup layer.
 */

import type {
  Confidence,
  CycleMeta,
  ProviderMeta,
  SourceRef,
  ClaimProvenance,
  RadarEnvelope,
} from './contracts.ts';

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/** A category of open-source projects the radar tracks, with its GitHub queries. */
export interface RadarCategory {
  id: string;
  label: string;
  description: string;
  queries: string[];
}

export type ConfidenceLevel = 'high' | 'medium' | 'watch';

export interface RankingConfidence {
  level: ConfidenceLevel;
  rationale: string;
  signals: {
    stars: boolean;
    forks: boolean;
    pushedRecent: boolean;
    licenseKnown: boolean;
    matchedTopics: boolean;
    sourceCount: boolean;
  };
}

/** One ingested + scored open-source project (mirror of the snapshot `Project`). */
export interface RadarProject {
  id: string; // lowercase fullName, e.g. "huggingface/transformers"
  name: string;
  fullName: string;
  description: string;
  url: string;
  homepage: string | null;
  owner: string;
  language: string | null;
  license: string | null; // SPDX id
  stars: number;
  forks: number;
  openIssues: number;
  topics: string[];
  pushedAt: string | null;
  createdAt: string | null;
  category: string;
  categoryLabel: string;
  sourceRefs: SourceRef[];
  sourceCount: number;
  sourceQuery: string;
  score: number; // repoScore()
  rankingConfidence: RankingConfidence;
  rank: number;
}

export interface CategoryCoverage {
  category: string;
  label: string;
  queryCount: number;
  completedQueries: number;
  failedQueries: number;
  uniqueRepos: number;
  status: 'ok' | 'partial' | 'empty';
}

// ---------------------------------------------------------------------------
// Momentum
// ---------------------------------------------------------------------------

export type ChatterPlatform =
  'hacker-news' | 'reddit' | 'devto' | 'medium' | 'youtube' | 'x-stub' | 'github-metadata';

export type MetricStatus = 'real' | 'proxy' | 'unavailable';

export interface ChatterPlatformResult {
  platform: ChatterPlatform;
  mentions: number;
  score: number; // 0–15
  status: MetricStatus;
  signals: string[];
  realMetrics: Array<Record<string, unknown>>;
  unavailableMetrics: string[];
}

export interface ChatterResult {
  schemaVersion: 'oss-chatter/v1';
  projectId: string;
  searchTerms: string[];
  platforms: ChatterPlatformResult[];
  mentions: number;
  score: number; // sum, max 90
  max: 90;
  status: 'real' | 'proxy';
  signals: string[];
  realMetrics: Array<Record<string, unknown>>;
  unavailableMetrics: string[];
}

export interface MomentumComponents {
  github: number;
  chatter: number;
  diversityBonus: number;
}

export interface MomentumForProject {
  projectId: string;
  score: number; // 0–45
  status: 'real' | 'proxy';
  signals: string[];
  realMetrics: Array<Record<string, unknown>>;
  unavailableMetrics: string[];
  components: MomentumComponents;
}

export interface MomentumSnapshot {
  schemaVersion: 'oss-momentum/v1';
  generatedAt: string;
  generatedBy: string;
  sourceSnapshotGeneratedAt: string;
  policy: {
    fetchMode: 'deterministic-no-network' | 'opt-in-network';
    allowedPlatforms: ChatterPlatform[];
    unavailableMetricPlaceholder: string;
  };
  stats: { projectCount: number; realMetricCount: number; unavailableMetricCount: number };
  lookup: { byProjectId: Record<string, MomentumForProject> };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  weightConfigId: string;
  githubAdoption: number;
  crossPlatformMomentum: number;
  recency: number;
  credibility: number;
  totalBeforeAdjustments: number;
  finalScore: number;
  adjustments: string[];
}

export interface RankedSignal extends RadarProject {
  score: number; // 0–100 (overrides repoScore on the ranked view)
  rank: number; // 1–10
  scoreBreakdown: ScoreBreakdown;
  momentum: MomentumForProject | null;
  rankingRationale: string;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type ArticleStatus = 'pending' | 'queued' | 'draft' | 'published' | 'skipped';

export interface RankHistoryEntry {
  rank: number;
  score: number;
  seenAt: string;
}

export interface LedgerProject {
  projectId: string;
  fullName: string;
  subtopic: string;
  subtopicLabel: string;
  firstSeen: string;
  lastSeen: string;
  droppedAt: string | null;
  articleStatus: ArticleStatus;
  rankHistory: RankHistoryEntry[];
  latestScore: number;
  latestMomentumStatus: 'real' | 'proxy';
}

export interface LedgerSnapshot {
  schemaVersion: 'oss-radar-ledger/v1';
  generatedAt: string;
  generatedBy: string;
  projects: Record<string, LedgerProject>;
  stats: {
    trackedCount: number;
    activeTopTenCount: number;
    droppedCount: number;
    articlePublishedCount: number;
  };
}

// ---------------------------------------------------------------------------
// Signal map
// ---------------------------------------------------------------------------

export type SignalNodeType =
  'project' | 'category' | 'owner' | 'language' | 'topic' | 'platform-source';

export type SignalRelation =
  'same-category' | 'same-org' | 'shared-language' | 'shared-topic' | 'co-mention' | 'cluster';

export interface SignalNode {
  id: string;
  type: SignalNodeType;
  label: string;
  rank?: number;
  score?: number;
}

export interface SignalEdge {
  from: string;
  to: string;
  relation: SignalRelation;
  weight: number;
  confidence: Confidence;
}

export interface SignalMapExport {
  schemaVersion: 'oss-signal-map-export/v1';
  generatedAt: string;
  generatedBy: string;
  stats: { nodeCount: number; edgeCount: number; projectCount: number };
  legend: { nodeTypes: SignalNodeType[]; relationTypes: SignalRelation[] };
  nodes: SignalNode[];
  edges: SignalEdge[];
  layout: { rings: Array<{ id: string; label: string; nodeTypes: SignalNodeType[] }> };
  rankedList: Array<{ id: string; nodeId: string; rank: number; score: number }>;
}

// ---------------------------------------------------------------------------
// Writeups (fact-grounded, AI-primary, with HOLD)
// ---------------------------------------------------------------------------

export type EditorialStatus = 'published' | 'held';

/** A grounded fact derived from a project's own GitHub signals (release/README/activity). */
export interface ProjectSignalFact {
  id: string;
  statement: string; // original expression, never a copied sentence
  quantity?: { metric: string; value: number; unit?: string; asOf?: string };
  entities: string[];
  provenance: Array<{ kind: string; url: string; quote?: string }>; // ≥1 always
  confidence: Confidence;
  extractedBy: ProviderMeta;
}

export interface ProjectWriteup {
  projectId: string;
  rank: number;
  headline: string;
  dek: string;
  body: string; // grounded prose (empty when held)
  whyItMatters: string;
  readerAction: string;
  confidence: Confidence;
  editorialStatus: EditorialStatus;
  holdReason?: string;
  facts: ProjectSignalFact[];
  claims: ClaimProvenance[];
  references: SourceRef[];
  ai: ProviderMeta;
}

// ---------------------------------------------------------------------------
// Top-level radar artifact
// ---------------------------------------------------------------------------

export interface RadarData {
  source: string;
  policy: {
    github: string;
    ai: string;
    ranking: string;
    chatterFetchMode: 'deterministic-no-network' | 'opt-in-network';
  };
  categories: RadarCategory[];
  coverage: CategoryCoverage[];
  projects: RadarProject[];
  topTen: RankedSignal[];
  momentum: MomentumSnapshot;
  ledger: LedgerSnapshot;
  signalMap: SignalMapExport;
  writeups: ProjectWriteup[];
  errors: string[];
}

export type RadarArtifact = RadarEnvelope<RadarData>;

/** Inputs the pipeline threads through every stage (deterministic + injectable). */
export interface RadarRunContext {
  now: Date;
  cycle: CycleMeta;
  env: NodeJS.ProcessEnv;
  /** Previous radar artifact (for ledger rank history / dropout continuity). */
  previous: RadarArtifact | null;
  /** Pluggable fetch — defaults to global fetch; injected in tests. */
  fetchImpl: typeof fetch;
}
