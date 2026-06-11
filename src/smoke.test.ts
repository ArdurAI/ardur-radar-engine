import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  repoScore,
  computeConfidence,
  githubMomentum,
  buildMomentumSnapshot,
  rankTopSignals,
  updateLedger,
  buildSignalMap,
  buildProvenanceFromFacts,
  enforceCopyright,
  deriveFacts,
  synthesizeWriteup,
  createProvider,
  runRadar,
  runCycle,
  cycleFor,
  describe as describeManifest,
  CONTRACT_REVISION,
  RADAR_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
} from './index.ts';
import type { RadarProject, RankedSignal, MomentumSnapshot, ProjectSignalFact } from './types.ts';
import type { AiProvider, GenerateRequest, GenerateResult } from './writeup/provider.ts';

const NOW = new Date('2026-06-11T06:00:00.000Z');

function makeProject(overrides: Partial<RadarProject> = {}): RadarProject {
  const base: RadarProject = {
    id: 'acme/widget',
    name: 'widget',
    fullName: 'acme/widget',
    description: 'A widget',
    url: 'https://github.com/acme/widget',
    homepage: null,
    owner: 'acme',
    language: 'TypeScript',
    license: 'MIT',
    stars: 12000,
    forks: 800,
    openIssues: 40,
    topics: ['ai', 'llm', 'agents', 'tooling'],
    pushedAt: '2026-06-09T00:00:00.000Z',
    createdAt: '2022-01-01T00:00:00.000Z',
    category: 'ai',
    categoryLabel: 'AI',
    sourceRefs: [],
    sourceCount: 1,
    sourceQuery: 'topic:llm stars:>500',
    score: 0,
    rankingConfidence: {
      level: 'high',
      rationale: '',
      signals: {
        stars: true,
        forks: true,
        pushedRecent: true,
        licenseKnown: true,
        matchedTopics: true,
        sourceCount: true,
      },
    },
    rank: 0,
  };
  return { ...base, ...overrides };
}

async function momentumFor(projects: RadarProject[]): Promise<MomentumSnapshot> {
  return buildMomentumSnapshot(projects, {}, fetch, NOW, cycleFor(NOW).id);
}

test('repoScore rises with stars', () => {
  const lo = repoScore(makeProject({ stars: 100 }), 2, NOW);
  const hi = repoScore(makeProject({ stars: 100000 }), 2, NOW);
  assert.ok(hi > lo);
});

test('computeConfidence tiers by signal count', () => {
  const strong = computeConfidence(makeProject(), true, NOW);
  assert.equal(strong.level, 'high');
  const weak = computeConfidence(
    makeProject({ stars: 10, forks: 1, license: null, sourceCount: 0, topics: [] }),
    false,
    NOW,
  );
  assert.equal(weak.level, 'watch');
});

test('githubMomentum clamps to 25 and rewards recency', () => {
  // Modest adoption so the recency bonus is visible below the 25-point clamp.
  const recent = githubMomentum(
    makeProject({ stars: 200, forks: 10, pushedAt: NOW.toISOString() }),
    NOW,
  );
  const stale = githubMomentum(
    makeProject({ stars: 200, forks: 10, pushedAt: '2024-01-01T00:00:00.000Z' }),
    NOW,
  );
  const maxed = githubMomentum(
    makeProject({ stars: 500000, forks: 90000, pushedAt: NOW.toISOString() }),
    NOW,
  );
  assert.ok(maxed <= 25);
  assert.ok(recent > stale);
});

test('ranking applies license and watch caps', async () => {
  const noLicense = makeProject({ id: 'a/no-license', fullName: 'a/no-license', license: null });
  const watch = makeProject({
    id: 'b/watch',
    fullName: 'b/watch',
    rankingConfidence: { ...makeProject().rankingConfidence, level: 'watch' },
  });
  const momentum = await momentumFor([noLicense, watch]);
  const ranked = rankTopSignals([noLicense, watch], momentum, NOW);
  const a = ranked.find((r) => r.id === 'a/no-license');
  const b = ranked.find((r) => r.id === 'b/watch');
  assert.ok(a && a.score <= 82);
  assert.ok(b && b.score <= 78);
});

test('ranking returns at most 10 ranked 1..n', async () => {
  const projects = Array.from({ length: 14 }, (_, i) =>
    makeProject({ id: `o/p${i}`, fullName: `o/p${i}`, stars: 1000 + i * 100 }),
  );
  const momentum = await momentumFor(projects);
  const ranked = rankTopSignals(projects, momentum, NOW);
  assert.equal(ranked.length, 10);
  assert.deepEqual(
    ranked.map((r) => r.rank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test('ledger tracks first-seen, history, and dropout', async () => {
  const p = makeProject();
  const momentum = await momentumFor([p]);
  const ranked = rankTopSignals([p], momentum, NOW);
  const led1 = updateLedger(ranked, null, NOW);
  assert.equal(led1.stats.trackedCount, 1);
  assert.equal(led1.projects[p.id]?.firstSeen, NOW.toISOString());

  // Next cycle: project drops out of an empty Top-10 → droppedAt set.
  const later = new Date('2026-06-11T12:00:00.000Z');
  const led2 = updateLedger([], led1, later);
  assert.equal(led2.projects[p.id]?.droppedAt, later.toISOString());
  assert.equal(led2.stats.droppedCount, 1);
});

test('signal map links projects to taxonomy nodes', async () => {
  const p = makeProject();
  const momentum = await momentumFor([p]);
  const ranked = rankTopSignals([p], momentum, NOW);
  const map = buildSignalMap(ranked, momentum, NOW);
  assert.ok(map.nodes.some((n) => n.type === 'project'));
  assert.ok(map.nodes.some((n) => n.type === 'category'));
  assert.ok(map.edges.some((e) => e.relation === 'same-category'));
  assert.equal(map.rankedList.length, 1);
});

test('provenance flags ungrounded claims', () => {
  const facts: ProjectSignalFact[] = deriveFacts(
    {
      ...makeProject(),
      score: 90,
      rank: 1,
      scoreBreakdown: {} as never,
      momentum: null,
      rankingRationale: '',
    } as RankedSignal,
    NOW,
  );
  const grounded = buildProvenanceFromFacts(
    [{ blockIndex: 0, text: `${facts[0]?.statement}`, isEditorial: false }],
    facts,
  );
  assert.equal(grounded.isGrounded, true);
  const ungrounded = buildProvenanceFromFacts(
    [{ blockIndex: 0, text: 'Totally unrelated sentence about penguins.', isEditorial: false }],
    facts,
  );
  assert.equal(ungrounded.isGrounded, false);
});

test('copyright screen catches credential leaks', () => {
  const verdict = enforceCopyright('here is a token sk-abcdefghijklmnopqrstuvwx', []);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.some((v) => v.kind === 'credential-leak'));
});

function rankedFixture(): RankedSignal {
  const p = makeProject();
  return {
    ...p,
    score: 88,
    rank: 1,
    scoreBreakdown: {
      weightConfigId: 'oss-ranking-v1',
      githubAdoption: 30,
      crossPlatformMomentum: 18,
      recency: 20,
      credibility: 20,
      totalBeforeAdjustments: 88,
      finalScore: 88,
      adjustments: [],
    },
    momentum: null,
    rankingRationale: 'test',
  };
}

test('deterministic provider holds the writeup (AI-primary)', async () => {
  const provider = createProvider({ now: NOW, env: { ARDUR_AI_PROVIDER: 'deterministic' } });
  const writeup = await synthesizeWriteup(rankedFixture(), provider, NOW);
  assert.equal(writeup.editorialStatus, 'held');
  assert.ok(writeup.facts.length > 0);
});

test('a grounded model writeup publishes', async () => {
  // A fake provider that cites the supplied facts inline → grounded.
  const fakeProvider: AiProvider = {
    name: 'ollama',
    canGenerate: () => true,
    generationsUsed: () => 1,
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const body = request.facts
        .slice(0, 2)
        .map((f) => `${f.statement} [FACT:${f.id}]`)
        .join(' ');
      return {
        draft: {
          headline: 'Widget rises',
          dek: 'AI',
          body,
          whyItMatters: `Adoption matters. [FACT:${request.facts[0]?.id}]`,
          readerAction: 'Review on GitHub.',
        },
        meta: {
          provider: 'ollama',
          model: 'test',
          status: 'generated',
          generatedAt: NOW.toISOString(),
        },
      };
    },
  };
  const writeup = await synthesizeWriteup(rankedFixture(), fakeProvider, NOW);
  assert.equal(writeup.editorialStatus, 'published');
  assert.ok(writeup.claims.every((c) => c.isEditorial || c.factIds.length > 0));
});

test('full pipeline emits a valid radar artifact (offline)', async () => {
  const seed = [makeProject(), makeProject({ id: 'o/two', fullName: 'o/two', stars: 5000 })];
  const artifact = await runRadar({ now: NOW, env: {}, seedProjects: seed });
  assert.equal(artifact.schemaVersion, RADAR_SCHEMA_VERSION);
  assert.equal(artifact.contractRevision, CONTRACT_REVISION);
  assert.equal(artifact.artifact, 'radar');
  assert.ok(artifact.data.topTen.length > 0);
  assert.ok(artifact.data.writeups.length > 0);
  // Deterministic default → every writeup is held.
  assert.ok(artifact.data.writeups.every((w) => w.editorialStatus === 'held'));
});

test('manifest reports contract revision and radar schema', () => {
  const m = describeManifest();
  assert.equal(m.contractRevision, CONTRACT_REVISION);
  assert.equal(m.radarSchemaVersion, RADAR_SCHEMA_VERSION);
  assert.ok(m.cli.flags.some((f) => f.flag === '--describe'));
});

test('cycleFor aligns to 6-hour UTC windows', () => {
  const c = cycleFor(new Date('2026-06-11T07:23:00.000Z'));
  assert.equal(c.windowStart, '2026-06-11T06:00:00.000Z');
  assert.equal(c.windowEnd, '2026-06-11T12:00:00.000Z');
});

// ──────────────── Cycle host tests ────────────────────────────────────────────

test('cycle host writes artifact and manifest to outputDir', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'radar-test-'));
  try {
    const result = await runCycle({
      outputDir,
      now: '2026-06-11T06:00:00.000Z',
      env: { ARDUR_AI_PROVIDER: 'deterministic' },
    });
    assert.equal(result.ok, true);
    assert.ok(result.runId.startsWith('run:'));
    assert.ok(result.artifactBytes > 0);
    assert.ok(result.durationMs >= 0);

    // latest/radar.json must exist and be valid.
    const latestJson = readFileSync(join(outputDir, 'latest', 'radar.json'), 'utf-8');
    const artifact = JSON.parse(latestJson) as { schemaVersion: string; artifact: string };
    assert.equal(artifact.schemaVersion, RADAR_SCHEMA_VERSION);
    assert.equal(artifact.artifact, 'radar');

    // manifest.json must exist, point to latest, and report ok.
    const manifestJson = readFileSync(join(outputDir, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestJson) as {
      schemaVersion: string;
      ok: boolean;
      latestPath: string;
      latestRunId: string;
    };
    assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.latestPath, 'latest/radar.json');
    assert.equal(manifest.latestRunId, result.runId);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('cycle host threads previous artifact for ledger continuity', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'radar-ledger-test-'));
  try {
    // First cycle — establishes the latest artifact.
    await runCycle({
      outputDir,
      now: '2026-06-11T06:00:00.000Z',
      env: { ARDUR_AI_PROVIDER: 'deterministic' },
    });

    // Second cycle — host reads latest/radar.json as previous, so ledger accumulates.
    const result2 = await runCycle({
      outputDir,
      now: '2026-06-11T12:00:00.000Z',
      env: { ARDUR_AI_PROVIDER: 'deterministic' },
    });
    assert.equal(result2.ok, true);

    // Manifest runId must have been updated to the second cycle.
    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf-8')) as {
      latestRunId: string;
    };
    assert.equal(manifest.latestRunId, result2.runId);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
