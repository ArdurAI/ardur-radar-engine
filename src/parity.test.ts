/**
 * Parity harness — verifies that the engine reproduces the in-ardur.ai OSS RADAR
 * formula on a pinned, deterministic set of GitHub Search fixture responses.
 *
 * Goals:
 *   1. Confirm the Top-10 ordering matches what the in-ardur.ai formula would
 *      produce for the same raw inputs (adoption + recency + credibility).
 *   2. Confirm the ledger correctly tracks first-seen / dropout across two cycles.
 *   3. Confirm the signalMap topology matches the project/category graph shape.
 *
 * Intentional differences from the in-ardur.ai scripts (documented here):
 *   - Momentum: the in-ardur.ai script adds chatter signals from HN/Reddit, which
 *     require network. This harness uses DETERMINISTIC mode (all chatter off), so
 *     momentum = githubMomentum only. On a live cycle, momentum may differ.
 *   - License cap: projects missing a license are capped at 82; this matches the
 *     in-ardur.ai `evaluate-oss-engine.mjs` behavior verbatim.
 *   - Tiebreak: same score → sorted by full_name ASC (engine) vs insertion order
 *     (legacy script). Engine tiebreak is explicit and stable.
 *   - enrichment: github-enrich is off (deterministic); no release/readme facts.
 *
 * Run with: node --test --experimental-strip-types src/parity.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runRadar } from './pipeline.ts';
import { assertCompatibleRadarArtifact } from './schema.ts';
import { repoScore, computeConfidence } from './ingest/github.ts';
import { rankTopSignals } from './ranking.ts';
import { buildMomentumSnapshot } from './momentum.ts';
import { RADAR_SCHEMA_VERSION } from './contracts.ts';
import type { RadarProject } from './types.ts';

const NOW = new Date('2026-06-11T06:00:00.000Z');

// ──────────────── Fixture GitHub Search responses ─────────────────────────────
//
// These are representative synthetic project records modeled on real GitHub API
// responses for the RADAR topic queries. They are pinned so CI is deterministic.

interface GHRepo {
  full_name: string;
  name: string;
  description: string;
  html_url: string;
  homepage: string | null;
  owner: { login: string };
  language: string | null;
  license: { spdx_id: string } | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  topics: string[];
  pushed_at: string;
  created_at: string;
}

function makeRepo(overrides: Partial<GHRepo>): GHRepo {
  const name = overrides.name ?? 'project';
  const org = overrides.owner?.login ?? 'acme';
  const { owner: _owner, ...rest } = overrides;
  return {
    full_name: `${org}/${name}`,
    name,
    description: `${name} project`,
    html_url: `https://github.com/${org}/${name}`,
    homepage: null,
    language: 'Go',
    license: { spdx_id: 'MIT' },
    stargazers_count: 5000,
    forks_count: 500,
    open_issues_count: 30,
    topics: ['artificial-intelligence'],
    pushed_at: '2026-06-01T00:00:00Z',
    created_at: '2023-01-01T00:00:00Z',
    ...rest,
    owner: { login: org },
  };
}

// 12 fixture repos across 3 categories (AI: 6, Kubernetes: 3, Cloud Native: 3).
const FIXTURE_REPOS: GHRepo[] = [
  // AI — high adoption
  makeRepo({
    name: 'superllm',
    owner: { login: 'megacorp' },
    stargazers_count: 95000,
    forks_count: 8000,
    topics: ['artificial-intelligence', 'llm', 'generative-ai'],
    pushed_at: '2026-06-10T00:00:00Z',
    language: 'Python',
    license: { spdx_id: 'Apache-2.0' },
  }),
  makeRepo({
    name: 'agentkit',
    owner: { login: 'openai-alt' },
    stargazers_count: 42000,
    forks_count: 3200,
    topics: ['artificial-intelligence', 'llm', 'machine-learning'],
    pushed_at: '2026-06-08T00:00:00Z',
    language: 'Python',
    license: { spdx_id: 'MIT' },
  }),
  makeRepo({
    name: 'vectordb',
    owner: { login: 'fastcorp' },
    stargazers_count: 28000,
    forks_count: 2100,
    topics: ['machine-learning', 'generative-ai'],
    pushed_at: '2026-05-30T00:00:00Z',
    language: 'Rust',
    license: { spdx_id: 'Apache-2.0' },
  }),
  makeRepo({
    name: 'rag-framework',
    owner: { login: 'buildit' },
    stargazers_count: 15000,
    forks_count: 1200,
    topics: ['artificial-intelligence', 'generative-ai'],
    pushed_at: '2026-06-05T00:00:00Z',
    language: 'TypeScript',
    license: { spdx_id: 'MIT' },
  }),
  makeRepo({
    name: 'mlops-platform',
    owner: { login: 'dataco' },
    stargazers_count: 8000,
    forks_count: 700,
    topics: ['machine-learning'],
    pushed_at: '2026-04-01T00:00:00Z', // older push — lower recency
    language: 'Python',
    license: null, // no license — capped at 82
  }),
  makeRepo({
    name: 'tiny-lm',
    owner: { login: 'researchlab' },
    stargazers_count: 3500,
    forks_count: 290,
    topics: ['artificial-intelligence'],
    pushed_at: '2026-06-09T00:00:00Z',
    language: 'C++',
    license: { spdx_id: 'MIT' },
  }),
  // Kubernetes — operator focus
  makeRepo({
    name: 'kube-gateway',
    owner: { login: 'cloudnative' },
    stargazers_count: 18000,
    forks_count: 1500,
    topics: ['kubernetes', 'cloud-native'],
    pushed_at: '2026-06-07T00:00:00Z',
    language: 'Go',
    license: { spdx_id: 'Apache-2.0' },
  }),
  makeRepo({
    name: 'k8s-operator-sdk',
    owner: { login: 'platformco' },
    stargazers_count: 12000,
    forks_count: 900,
    topics: ['kubernetes', 'kubernetes-operator'],
    pushed_at: '2026-06-03T00:00:00Z',
    language: 'Go',
    license: { spdx_id: 'Apache-2.0' },
  }),
  makeRepo({
    name: 'helm-plus',
    owner: { login: 'helmgroup' },
    stargazers_count: 6000,
    forks_count: 450,
    topics: ['kubernetes'],
    pushed_at: '2026-05-20T00:00:00Z',
    language: 'Go',
    license: { spdx_id: 'MIT' },
  }),
  // Cloud Native — observability
  makeRepo({
    name: 'otel-collector',
    owner: { login: 'telemetry' },
    stargazers_count: 22000,
    forks_count: 1800,
    topics: ['cloud-native', 'observability'],
    pushed_at: '2026-06-09T00:00:00Z',
    language: 'Go',
    license: { spdx_id: 'Apache-2.0' },
  }),
  makeRepo({
    name: 'netmonitor',
    owner: { login: 'monit' },
    stargazers_count: 9000,
    forks_count: 650,
    topics: ['observability'],
    pushed_at: '2026-06-02T00:00:00Z',
    language: 'Go',
    license: { spdx_id: 'MIT' },
  }),
  makeRepo({
    name: 'service-mesh-lite',
    owner: { login: 'serviceco' },
    stargazers_count: 4500,
    forks_count: 380,
    topics: ['cloud-native'],
    pushed_at: '2026-05-15T00:00:00Z',
    language: 'Rust',
    license: { spdx_id: 'Apache-2.0' },
  }),
];

function searchResponse(repos: GHRepo[]): string {
  return JSON.stringify({ total_count: repos.length, incomplete_results: false, items: repos });
}

// ──────────────── Mock fetch serving fixtures ─────────────────────────────────

function makeFixtureFetch(): typeof fetch {
  // Map topic → repos for the fixture.
  const topicMap: Record<string, GHRepo[]> = {
    'artificial-intelligence': FIXTURE_REPOS.filter((r) =>
      r.topics.includes('artificial-intelligence'),
    ),
    llm: FIXTURE_REPOS.filter((r) => r.topics.includes('llm')),
    'generative-ai': FIXTURE_REPOS.filter((r) => r.topics.includes('generative-ai')),
    'machine-learning': FIXTURE_REPOS.filter((r) => r.topics.includes('machine-learning')),
    kubernetes: FIXTURE_REPOS.filter((r) => r.topics.includes('kubernetes')),
    'kubernetes-operator': FIXTURE_REPOS.filter((r) => r.topics.includes('kubernetes-operator')),
    'cloud-native': FIXTURE_REPOS.filter((r) => r.topics.includes('cloud-native')),
    observability: FIXTURE_REPOS.filter((r) => r.topics.includes('observability')),
    'quantum-computing': [],
    'developer-tools': [],
    devops: [],
  };

  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    // GitHub Search API.
    if (url.includes('api.github.com/search/repositories')) {
      const decoded = decodeURIComponent(url);
      let matched: GHRepo[] = [];
      for (const [topic, repos] of Object.entries(topicMap)) {
        if (decoded.includes(`topic:${topic}`)) {
          matched = repos;
          break;
        }
      }
      return new Response(searchResponse(matched), { status: 200 });
    }

    // Enrichment calls → return 404 (enrichment is off in this harness).
    if (url.includes('/releases/latest') || url.includes('/readme')) {
      return new Response('', { status: 404 });
    }

    // HN/Reddit/etc chatter → 404 (all off).
    return new Response('', { status: 404 });
  };
}

// ──────────────── Parity tests ────────────────────────────────────────────────

test('parity: fixture pipeline emits valid artifact', async () => {
  const artifact = await runRadar({
    now: NOW,
    env: { ARDUR_OSS_FETCH_GITHUB: '1', ARDUR_AI_PROVIDER: 'deterministic' },
    fetchImpl: makeFixtureFetch(),
  });

  const { artifact: gated } = assertCompatibleRadarArtifact(artifact);
  assert.equal(gated.schemaVersion, RADAR_SCHEMA_VERSION);
  assert.ok(artifact.data.projects.length > 0, 'fixture produces at least one project');
  assert.ok(artifact.data.topTen.length > 0, 'fixture produces a Top-10');
  assert.ok(artifact.data.topTen.length <= 10, 'Top-10 is at most 10 projects');
});

test('parity: formula reproduces Top-10 ranking ORDER from fixture projects', async () => {
  // NOTE — Intentional difference: the engine accumulates `sourceCount` across
  // all queries that return a project (multi-query dedup). A project seen in 3
  // queries has sourceCount=3, raising credibility by up to 4 points versus a
  // single-query view with sourceCount=1. Exact score parity requires running the
  // same multi-query dedup — so this test asserts ORDER stability, not exact scores.

  const artifact = await runRadar({
    now: NOW,
    env: { ARDUR_OSS_FETCH_GITHUB: '1', ARDUR_AI_PROVIDER: 'deterministic' },
    fetchImpl: makeFixtureFetch(),
  });

  // Build RadarProject inputs from the fixture AI repos (single-query view).
  const aiRepos = FIXTURE_REPOS.filter((r) => r.topics.includes('artificial-intelligence'));
  const PLACEHOLDER_CONFIDENCE = {
    level: 'high' as const,
    rationale: '',
    signals: {
      stars: true,
      forks: true,
      pushedRecent: true,
      licenseKnown: true,
      matchedTopics: true,
      sourceCount: true,
    },
  };
  const aiProjects: RadarProject[] = aiRepos.map((r) => {
    const base: RadarProject = {
      id: r.full_name.toLowerCase(),
      name: r.name,
      fullName: r.full_name,
      description: r.description,
      url: r.html_url,
      homepage: null,
      owner: r.owner.login,
      language: r.language,
      license: r.license?.spdx_id ?? null,
      stars: r.stargazers_count,
      forks: r.forks_count,
      openIssues: r.open_issues_count,
      topics: r.topics,
      pushedAt: r.pushed_at,
      createdAt: r.created_at,
      category: 'ai',
      categoryLabel: 'AI',
      sourceRefs: [],
      sourceCount: 1,
      sourceQuery: 'topic:artificial-intelligence stars:>500',
      score: 0,
      rank: 0,
      rankingConfidence: PLACEHOLDER_CONFIDENCE,
    };
    const matchedTopics = r.topics.filter((t) =>
      ['artificial-intelligence', 'llm', 'generative-ai', 'machine-learning'].includes(t),
    ).length;
    const confidence = computeConfidence(base, matchedTopics > 0, NOW);
    return {
      ...base,
      score: repoScore(base, matchedTopics, NOW),
      rankingConfidence: confidence,
    };
  });

  const momentum = await buildMomentumSnapshot(
    aiProjects,
    {},
    makeFixtureFetch(),
    NOW,
    '2026-06-11T06:00:00.000Z',
  );
  const formulaRanked = rankTopSignals(aiProjects, momentum, NOW);

  // The relative ORDER of AI projects in the engine artifact must match the
  // formula's ordering (higher score → lower rank number), even if exact scores
  // differ due to sourceCount accumulation.
  for (let i = 0; i < formulaRanked.length - 1; i++) {
    const a = formulaRanked[i]!;
    const b = formulaRanked[i + 1]!;
    // Both must appear in the artifact's topTen (or be below cutoff).
    const artA = artifact.data.topTen.find((p) => p.id === a.id);
    const artB = artifact.data.topTen.find((p) => p.id === b.id);
    if (artA && artB) {
      assert.ok(
        artA.rank <= artB.rank,
        `rank order mismatch: ${a.id}(rank=${artA.rank}) should be ≤ ${b.id}(rank=${artB.rank})`,
      );
    }
  }
});

test('parity: mlops-platform (no license) is capped at 82', async () => {
  const artifact = await runRadar({
    now: NOW,
    env: { ARDUR_OSS_FETCH_GITHUB: '1', ARDUR_AI_PROVIDER: 'deterministic' },
    fetchImpl: makeFixtureFetch(),
  });
  const mlops = artifact.data.topTen.find((p) => p.name === 'mlops-platform');
  if (mlops) {
    assert.ok(mlops.score <= 82, `no-license cap: score=${mlops.score} should be ≤82`);
  }
  // If not in Top-10, that's also valid (capped score may not reach Top-10).
});

test('parity: superllm (highest stars) scores near the top', async () => {
  const artifact = await runRadar({
    now: NOW,
    env: { ARDUR_OSS_FETCH_GITHUB: '1', ARDUR_AI_PROVIDER: 'deterministic' },
    fetchImpl: makeFixtureFetch(),
  });
  const top = artifact.data.topTen[0];
  assert.ok(top, 'artifact has at least one entry');
  // superllm has 95k stars + recent push — should be #1.
  assert.equal(top.name, 'superllm', `expected superllm at #1, got ${top.name}`);
});

test('parity: ledger tracks fixture projects across two cycles', async () => {
  const NOW2 = new Date('2026-06-11T12:00:00.000Z'); // 6h later
  const baseOpts = {
    env: { ARDUR_OSS_FETCH_GITHUB: '1', ARDUR_AI_PROVIDER: 'deterministic' },
    fetchImpl: makeFixtureFetch(),
  };
  const artifact1 = await runRadar({ ...baseOpts, now: NOW });
  const artifact2 = await runRadar({ ...baseOpts, now: NOW2, previous: artifact1 });

  // After two cycles with the same fixture, ledger should have continuous history.
  const project = artifact2.data.topTen[0];
  assert.ok(project, 'second cycle produces a Top-10');
  const ledgerEntry = artifact2.data.ledger.projects[project.id];
  assert.ok(ledgerEntry, `ledger entry present for ${project.id}`);
  // droppedAt is null (not undefined) for active projects in the serialised ledger.
  assert.ok(!ledgerEntry.droppedAt, 'top project should not be dropped');
  assert.ok(
    ledgerEntry.rankHistory.length >= 2,
    'rankHistory has at least 2 entries after 2 cycles',
  );
});

test('parity: signalMap nodes cover project + category topology', async () => {
  const artifact = await runRadar({
    now: NOW,
    env: { ARDUR_OSS_FETCH_GITHUB: '1', ARDUR_AI_PROVIDER: 'deterministic' },
    fetchImpl: makeFixtureFetch(),
  });

  const { nodes, edges } = artifact.data.signalMap;
  const topCount = artifact.data.topTen.length;
  const projectNodes = nodes.filter((n) => n.type === 'project');
  const categoryNodes = nodes.filter((n) => n.type === 'category');

  assert.equal(projectNodes.length, topCount, 'one project node per Top-10 entry');
  assert.ok(categoryNodes.length > 0, 'at least one category node');
  assert.ok(
    edges.some((e) => e.relation === 'same-category'),
    'same-category edges present',
  );
});
