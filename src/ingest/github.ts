/**
 * GitHub ingestion — the radar's primary data source.
 *
 * Ports `refresh-open-source-radar.mjs`: allow-listed GitHub Search topic queries
 * per category → typed `RadarProject[]` ranked by `repoScore`, with a per-project
 * `rankingConfidence`. Live fetches happen only when a token is present (or an
 * explicit opt-in flag is set); otherwise ingestion returns an empty, valid
 * result with a warning so CI and tests stay zero-network and deterministic.
 */

import type { SourceRef } from '../contracts.ts';
import type {
  RadarCategory,
  RadarProject,
  CategoryCoverage,
  RankingConfidence,
  ConfidenceLevel,
} from '../types.ts';
import { ageDays, boundedText, envFlag, envInt, log10p1, safePublicUrl, unique } from '../util.ts';

const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PER_PAGE = 20;

/** The radar's tracked categories. Mirrors the in-ardur.ai allow-list. */
export const RADAR_CATEGORIES: RadarCategory[] = [
  {
    id: 'ai',
    label: 'AI',
    description: 'Artificial intelligence, LLMs, and generative model tooling.',
    queries: [
      'topic:artificial-intelligence stars:>500 archived:false',
      'topic:llm stars:>500 archived:false',
      'topic:generative-ai stars:>500 archived:false',
      'topic:machine-learning stars:>1000 archived:false',
    ],
  },
  {
    id: 'kubernetes',
    label: 'Kubernetes',
    description: 'Kubernetes operators, controllers, and platform add-ons.',
    queries: [
      'topic:kubernetes stars:>500 archived:false',
      'topic:kubernetes-operator stars:>300 archived:false',
    ],
  },
  {
    id: 'cloud-native',
    label: 'Cloud Native',
    description: 'Cloud-native infrastructure, observability, and delivery tooling.',
    queries: [
      'topic:cloud-native stars:>500 archived:false',
      'topic:observability stars:>500 archived:false',
    ],
  },
  {
    id: 'quantum',
    label: 'Quantum Tech',
    description: 'Quantum computing frameworks and simulators.',
    queries: ['topic:quantum-computing stars:>300 archived:false'],
  },
  {
    id: 'software-engineering',
    label: 'Software Engineering',
    description: 'Developer tooling, languages, and engineering productivity.',
    queries: [
      'topic:developer-tools stars:>1000 archived:false',
      'topic:devops stars:>1000 archived:false',
    ],
  },
];

interface GithubRepo {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  owner: { login: string };
  language: string | null;
  license: { spdx_id: string | null } | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  topics?: string[];
  pushed_at: string | null;
  created_at: string | null;
}

/** Topics referenced by a category's queries (for the topic-match bonus). */
function categoryTopics(category: RadarCategory): string[] {
  const topics: string[] = [];
  for (const q of category.queries) {
    const m = q.match(/topic:([^\s]+)/g) ?? [];
    for (const t of m) topics.push(t.replace('topic:', ''));
  }
  return unique(topics);
}

/**
 * Initial ranking score — ported verbatim from `repoScore()`.
 * log-adoption + recency window + topic bonus − missing-license penalty.
 */
export function repoScore(
  repo: Pick<RadarProject, 'stars' | 'forks' | 'openIssues' | 'pushedAt' | 'license'>,
  matchedTopicCount: number,
  now: Date,
): number {
  const recency = Math.max(0, 120 - ageDays(repo.pushedAt, now));
  const topicBonus = matchedTopicCount * 8;
  const licensePenalty = repo.license ? 0 : -8;
  return (
    log10p1(repo.stars) * 45 +
    log10p1(repo.forks) * 18 +
    Math.min(repo.openIssues, 200) * 0.04 +
    recency +
    topicBonus +
    licensePenalty
  );
}

/** Confidence tier — ported from the 6-signal vote in `refresh-open-source-radar.mjs`. */
export function computeConfidence(
  project: Pick<
    RadarProject,
    'stars' | 'forks' | 'pushedAt' | 'license' | 'sourceCount' | 'topics'
  >,
  matchedTopics: boolean,
  now: Date,
): RankingConfidence {
  const signals = {
    stars: project.stars >= 5000,
    forks: project.forks >= 250,
    pushedRecent: ageDays(project.pushedAt, now) <= 45,
    licenseKnown: Boolean(project.license),
    matchedTopics,
    sourceCount: project.sourceCount > 0,
  };
  const votes = Object.values(signals).filter(Boolean).length;
  const level: ConfidenceLevel = votes >= 5 ? 'high' : votes >= 3 ? 'medium' : 'watch';
  const rationale =
    level === 'high'
      ? 'Strong adoption, recent activity, and known license across multiple signals.'
      : level === 'medium'
        ? 'Mixed signals — adoption present but some trust markers missing.'
        : 'Low-signal candidate kept on the watchlist pending corroboration.';
  return { level, rationale, signals };
}

function mapRepo(
  repo: GithubRepo,
  category: RadarCategory,
  query: string,
  now: Date,
): RadarProject {
  const fullName = repo.full_name;
  const topics = repo.topics ?? [];
  const catTopics = categoryTopics(category);
  const matchedTopicCount = topics.filter((t) => catTopics.includes(t)).length;
  const license = repo.license?.spdx_id ?? null;
  const base = {
    id: fullName.toLowerCase(),
    name: repo.name,
    fullName,
    description: repo.description ?? '',
    url: repo.html_url,
    homepage: safePublicUrl(repo.homepage), // #15: sanitize untrusted API value.
    owner: repo.owner.login,
    language: repo.language,
    license,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    topics,
    pushedAt: repo.pushed_at,
    createdAt: repo.created_at,
    category: category.id,
    categoryLabel: category.label,
    sourceRefs: [] as SourceRef[],
    sourceCount: 0,
    sourceQuery: query,
  };
  const confidence = computeConfidence(base, matchedTopicCount > 0, now);
  return {
    ...base,
    score: repoScore(base, matchedTopicCount, now),
    rankingConfidence: confidence,
    rank: 0,
  };
}

export interface IngestResult {
  projects: RadarProject[];
  coverage: CategoryCoverage[];
  errors: string[];
}

/** True when the engine is allowed to make live GitHub Search calls. */
export function githubLiveEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['GITHUB_TOKEN'] ?? env['GH_TOKEN']) || envFlag(env, 'ARDUR_OSS_FETCH_GITHUB');
}

async function searchCategory(
  category: RadarCategory,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<{ projects: RadarProject[]; coverage: CategoryCoverage; errors: string[] }> {
  const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  const delayMs = envInt(env, 'ARDUR_GITHUB_SEARCH_DELAY_MS', 0);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ardur-radar-engine',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const byId = new Map<string, RadarProject>();
  const errors: string[] = [];
  let completed = 0;
  let failed = 0;

  for (const query of category.queries) {
    const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${PER_PAGE}`;
    try {
      const res = await fetchImpl(url, { headers });
      if (!res.ok) {
        failed++;
        errors.push(`${category.id}: HTTP ${res.status} for "${query}"`);
        continue;
      }
      const text = await boundedText(res, MAX_RESPONSE_BYTES);
      const parsed = JSON.parse(text) as { items?: GithubRepo[] };
      for (const repo of parsed.items ?? []) {
        const project = mapRepo(repo, category, query, now);
        const existing = byId.get(project.id);
        if (!existing || project.score > existing.score) byId.set(project.id, project);
      }
      completed++;
    } catch (err: unknown) {
      failed++;
      errors.push(`${category.id}: ${err instanceof Error ? err.message : 'fetch failed'}`);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  const projects = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, PER_PAGE);
  const coverage: CategoryCoverage = {
    category: category.id,
    label: category.label,
    queryCount: category.queries.length,
    completedQueries: completed,
    failedQueries: failed,
    uniqueRepos: projects.length,
    status: projects.length === 0 ? 'empty' : failed > 0 ? 'partial' : 'ok',
  };
  return { projects, coverage, errors };
}

/**
 * Ingest fresh projects across all categories. On the deterministic default path
 * (no token, no opt-in) this returns an empty result and a single warning rather
 * than touching the network.
 */
export async function ingestProjects(
  categories: RadarCategory[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<IngestResult> {
  if (!githubLiveEnabled(env)) {
    return {
      projects: [],
      coverage: categories.map((c) => ({
        category: c.id,
        label: c.label,
        queryCount: c.queries.length,
        completedQueries: 0,
        failedQueries: 0,
        uniqueRepos: 0,
        status: 'empty' as const,
      })),
      errors: ['github ingestion skipped — no GITHUB_TOKEN/GH_TOKEN and ARDUR_OSS_FETCH_GITHUB!=1'],
    };
  }

  const all = new Map<string, RadarProject>();
  const coverage: CategoryCoverage[] = [];
  const errors: string[] = [];
  for (const category of categories) {
    const result = await searchCategory(category, env, fetchImpl, now);
    coverage.push(result.coverage);
    errors.push(...result.errors);
    for (const project of result.projects) {
      const existing = all.get(project.id);
      if (!existing || project.score > existing.score) all.set(project.id, project);
    }
  }
  const projects = [...all.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));
  return { projects, coverage, errors };
}
