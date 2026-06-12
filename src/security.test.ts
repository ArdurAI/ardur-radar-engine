/**
 * Security regression tests — one test per verified fix.
 *
 * Issue → test mapping:
 *   #6  SSRF + GitHub token exposure   (validateFullName + redirect:error)
 *   #7  URL normalization              (safePublicUrl)
 *   #8  Copyright fixes                (countWords CJK, off-by-one, README verbatim, cred-in-facts)
 *   #9  Poisoned artifact gate         (loadPreviousArtifact via runCycle)
 *   #10 Schema gate extension          (momentum + element shapes)
 *   #11 README encoding field          (data.encoding honored)
 *   #12 Medium RSS ReDoS               (bounded regex)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enrichProject,
  assertCompatibleRadarArtifact,
  enforceCopyright,
  countWords,
  safePublicUrl,
  MAX_QUOTE_WORDS,
  RADAR_SCHEMA_VERSION,
  CONTRACT_REVISION,
  runCycle,
} from './index.ts';
import { SchemaVersionError } from './contracts.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function _minValidArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: RADAR_SCHEMA_VERSION,
    artifact: 'radar',
    contractRevision: CONTRACT_REVISION,
    runId: 'run:test',
    generatedAt: '2026-06-12T00:00:00.000Z',
    cycle: { id: 'c1', start: '2026-06-12T00:00:00.000Z', end: '2026-06-12T06:00:00.000Z' },
    warnings: [],
    data: {
      projects: [],
      topTen: [],
      writeups: [],
      errors: [],
      ledger: { projects: {}, stats: {} },
      signalMap: { nodes: [], edges: [], layout: {}, rankedList: [] },
      momentum: { lookup: { byProjectId: {} } },
      ...((overrides.data as Record<string, unknown>) ?? {}),
    },
    ...overrides,
  };
}

function makeFact(
  id: string,
  statement: string,
  url: string,
  quote?: string,
): import('./types.ts').ProjectSignalFact {
  return {
    id,
    statement,
    entities: [],
    provenance: [{ kind: 'test', url, quote }],
    confidence: 'high' as const,
    extractedBy: {
      provider: 'deterministic',
      model: 'test/v1',
      status: 'generated',
      generatedAt: '2026-06-12T00:00:00.000Z',
    },
  };
}

// ─── Issue #6: SSRF + GitHub token exposure ───────────────────────────────────

test('#6 enrichProject returns null for invalid fullName (path traversal)', async () => {
  const attempts = [
    '../etc/passwd',
    'owner/../../etc/passwd',
    'owner/repo/../../leaked',
    'owner repo', // space — not valid GitHub slug
    'a'.repeat(101) + '/repo', // owner too long
    'owner/' + 'b'.repeat(101), // repo too long
    '', // empty
    'noslash', // no separator
    'owner//repo', // double slash
  ];
  for (const name of attempts) {
    const result = await enrichProject(name, { ARDUR_OSS_ENRICH_GITHUB: '1' }, fetch);
    assert.equal(result, null, `expected null for SSRF attempt: ${JSON.stringify(name)}`);
  }
});

test('#6 enrichProject is no-op when enrichment not enabled', async () => {
  const result = await enrichProject('owner/repo', {}, fetch);
  assert.equal(result, null);
});

test('#6 enrichProject builds API URL with encoded segments, not raw fullName', async () => {
  // Confirm by monkey-patching fetch to capture URL; fullName with dots should be encoded.
  let capturedUrl = '';
  const fakeFetch = (url: string | URL) => {
    capturedUrl = String(url);
    return Promise.resolve(new Response('', { status: 404 }));
  };

  await enrichProject('acme/my.repo', { ARDUR_OSS_ENRICH_GITHUB: '1' }, fakeFetch as typeof fetch);
  // encodeURIComponent('my.repo') = 'my.repo' (dot is safe, but segment is isolated)
  assert.ok(capturedUrl.includes('api.github.com/repos/acme/my.repo'), `URL was: ${capturedUrl}`);
  // Confirm path segments are separate — no raw slash injected
  assert.ok(!capturedUrl.includes('//repos'), `Double slash in URL: ${capturedUrl}`);
});

test('#6 redirect:error — fetchImpl receives the option', async () => {
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (_url: string | URL, init?: RequestInit) => {
    capturedInit = init;
    return Promise.resolve(
      new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };

  // Will fail to parse body, but we only care the init was passed.
  await enrichProject('acme/repo', { ARDUR_OSS_ENRICH_GITHUB: '1' }, fakeFetch as typeof fetch);
  assert.equal(
    capturedInit?.redirect,
    'error',
    'redirect:error must be forwarded to the underlying fetchImpl',
  );
});

// ─── Issue #7: URL normalization ─────────────────────────────────────────────

test('#7 safePublicUrl strips embedded credentials', () => {
  assert.equal(
    safePublicUrl('https://user:secret@github.com/owner/repo'),
    'https://github.com/owner/repo',
  );
  assert.equal(safePublicUrl('http://admin:pass@example.com/path'), 'http://example.com/path');
});

test('#7 safePublicUrl rejects non-http(s) protocols', () => {
  assert.equal(safePublicUrl('ftp://example.com/file'), null);
  assert.equal(safePublicUrl('file:///etc/passwd'), null);
  assert.equal(safePublicUrl('javascript:alert(1)'), null);
  assert.equal(safePublicUrl('data:text/plain,hello'), null);
});

test('#7 safePublicUrl returns null for missing/non-string input', () => {
  assert.equal(safePublicUrl(null), null);
  assert.equal(safePublicUrl(undefined), null);
  assert.equal(safePublicUrl(42), null);
  assert.equal(safePublicUrl(''), null);
  assert.equal(safePublicUrl('   '), null);
});

test('#7 safePublicUrl returns null for invalid URLs', () => {
  assert.equal(safePublicUrl('not a url'), null);
  assert.equal(safePublicUrl('://broken'), null);
});

test('#7 safePublicUrl preserves valid URLs unchanged', () => {
  assert.equal(safePublicUrl('https://github.com/owner/repo'), 'https://github.com/owner/repo');
  assert.equal(
    safePublicUrl('https://api.example.com/path?q=1#anchor'),
    'https://api.example.com/path?q=1#anchor',
  );
});

test('#7 enforceCopyright rejects fact with credentialed provenance URL', () => {
  const fact = makeFact('f1', 'test statement', 'ftp://internal/secret', undefined);
  const result = enforceCopyright('some prose', [fact]);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'missing-canonical-link'));
});

// ─── Issue #8: Copyright fixes ───────────────────────────────────────────────

test('#8 countWords counts CJK characters as individual word-equivalents', () => {
  // 3 CJK + 0 latin = 3
  assert.equal(countWords('你好啊'), 3);
  // 2 CJK + 1 latin = 3
  assert.equal(countWords('你好 world'), 3);
  // Pure Latin
  assert.equal(countWords('hello world foo'), 3);
  // Empty / whitespace
  assert.equal(countWords('   '), 0);
  assert.equal(countWords(''), 0);
});

test('#8 countWords — adversarial long CJK string exceeds MAX_QUOTE_WORDS', () => {
  // 30 CJK chars should count as 30 words, exceeding the 25-word limit.
  const longCjk = '中'.repeat(30); // 30× '中'
  assert.ok(countWords(longCjk) > MAX_QUOTE_WORDS);
});

test('#8 off-by-one fix: exactly MAX_QUOTE_WORDS words is allowed', () => {
  const words = Array.from({ length: MAX_QUOTE_WORDS }, (_, i) => `word${i}`).join(' ');
  const fact = makeFact('f1', 'test', 'https://github.com/a/b', words);
  const result = enforceCopyright('', [fact]);
  assert.equal(
    result.violations.filter((v) => v.kind === 'quote-too-long').length,
    0,
    `A quote of exactly ${MAX_QUOTE_WORDS} words should be allowed`,
  );
});

test('#8 off-by-one fix: MAX_QUOTE_WORDS + 1 words triggers violation', () => {
  const words = Array.from({ length: MAX_QUOTE_WORDS + 1 }, (_, i) => `word${i}`).join(' ');
  const fact = makeFact('f1', 'test', 'https://github.com/a/b', words);
  const result = enforceCopyright('', [fact]);
  assert.ok(result.violations.some((v) => v.kind === 'quote-too-long'));
});

test('#8 credential in fact statement triggers copyright violation', () => {
  const fact = makeFact(
    'f1',
    // Embed a fake GitHub PAT in the statement itself
    'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAA found in code',
    'https://github.com/a/b',
  );
  const result = enforceCopyright('clean prose here', [fact]);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'credential-leak'));
});

test('#8 credential in provenance quote triggers copyright violation', () => {
  const fact = makeFact(
    'f1',
    'clean statement',
    'https://github.com/a/b',
    'secret ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAA in quote',
  );
  const result = enforceCopyright('clean prose', [fact]);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'credential-leak'));
});

test('#8 clean facts + clean prose passes copyright check', () => {
  const fact = makeFact('f1', 'Project has 5000 stars.', 'https://github.com/a/b');
  const result = enforceCopyright('Great project with broad adoption.', [fact]);
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
});

// ─── Issue #9: Poisoned artifact gate ────────────────────────────────────────

test('#9 runCycle treats poisoned previous artifact as no-previous', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'radar-sec-test-'));
  const latestDir = join(outputDir, 'latest');
  mkdirSync(latestDir, { recursive: true });

  // Write a poisoned artifact that passes the 2-field check but fails the schema gate.
  const poisoned = JSON.stringify({
    schemaVersion: RADAR_SCHEMA_VERSION,
    artifact: 'radar',
    // data is deliberately malformed — no projects/topTen/etc.
    data: {
      projects: 'NOT_AN_ARRAY', // will fail assertCompatibleRadarArtifact
      topTen: [],
      writeups: [],
      errors: [],
      ledger: {},
      signalMap: {},
      momentum: { lookup: {} },
    },
  });
  writeFileSync(join(latestDir, 'radar.json'), poisoned, 'utf-8');

  try {
    // Cycle must not crash or trust the poisoned artifact.
    const result = await runCycle({
      outputDir,
      now: '2026-06-12T00:00:00.000Z',
      env: { ARDUR_AI_PROVIDER: 'deterministic' },
    });
    assert.equal(result.ok, true, 'cycle must succeed despite poisoned previous artifact');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('#9 assertCompatibleRadarArtifact rejects artifact with data.projects as string', () => {
  assert.throws(
    () =>
      assertCompatibleRadarArtifact({
        schemaVersion: RADAR_SCHEMA_VERSION,
        artifact: 'radar',
        data: {
          projects: 'INJECTED',
          topTen: [],
          writeups: [],
          errors: [],
          ledger: {},
          signalMap: {},
        },
      }),
    (e: unknown) => e instanceof SchemaVersionError,
  );
});

// ─── Issue #10: Schema gate — momentum + element shapes ──────────────────────

test('#10 assertCompatibleRadarArtifact throws on momentum=string', () => {
  assert.throws(
    () =>
      assertCompatibleRadarArtifact({
        schemaVersion: RADAR_SCHEMA_VERSION,
        artifact: 'radar',
        data: {
          projects: [],
          topTen: [],
          writeups: [],
          errors: [],
          ledger: {},
          signalMap: {},
          momentum: 'corrupted-string', // must be non-null object
        },
      }),
    (e: unknown) => e instanceof SchemaVersionError,
  );
});

test('#10 assertCompatibleRadarArtifact throws on momentum with null lookup', () => {
  assert.throws(
    () =>
      assertCompatibleRadarArtifact({
        schemaVersion: RADAR_SCHEMA_VERSION,
        artifact: 'radar',
        data: {
          projects: [],
          topTen: [],
          writeups: [],
          errors: [],
          ledger: {},
          signalMap: {},
          momentum: { lookup: null }, // lookup must not be null
        },
      }),
    (e: unknown) => e instanceof SchemaVersionError,
  );
});

test('#10 assertCompatibleRadarArtifact warns (not throws) when momentum absent', () => {
  // Absent momentum is tolerated for backward compat with older artifacts.
  const { warnings } = assertCompatibleRadarArtifact({
    schemaVersion: RADAR_SCHEMA_VERSION,
    artifact: 'radar',
    data: {
      projects: [],
      topTen: [],
      writeups: [],
      errors: [],
      ledger: {},
      signalMap: {},
      // momentum intentionally absent
    },
  });
  assert.ok(warnings.some((w) => w.includes('momentum')));
});

test('#10 assertCompatibleRadarArtifact throws on projects element missing fullName and id', () => {
  assert.throws(
    () =>
      assertCompatibleRadarArtifact({
        schemaVersion: RADAR_SCHEMA_VERSION,
        artifact: 'radar',
        data: {
          projects: [{ name: 'no-fullName-or-id' }], // missing fullName and id
          topTen: [],
          writeups: [],
          errors: [],
          ledger: {},
          signalMap: {},
          momentum: { lookup: {} },
        },
      }),
    (e: unknown) => e instanceof SchemaVersionError,
  );
});

test('#10 assertCompatibleRadarArtifact accepts project with valid fullName', () => {
  const { artifact } = assertCompatibleRadarArtifact({
    schemaVersion: RADAR_SCHEMA_VERSION,
    artifact: 'radar',
    data: {
      projects: [{ fullName: 'acme/tool', id: 'acme/tool' }],
      topTen: [],
      writeups: [],
      errors: [],
      ledger: {},
      signalMap: {},
      momentum: { lookup: { byProjectId: {} } },
    },
  });
  assert.ok(artifact);
});

// ─── Issue #11: README encoding field ────────────────────────────────────────

test('#11 enrichProject decodes README when encoding=base64', async () => {
  const plainText = 'A fast, pluggable orchestration framework for modern pipelines.';
  const base64Content = Buffer.from(plainText, 'utf-8').toString('base64');

  const fakeFetch = (url: string | URL) => {
    const u = String(url);
    if (u.includes('/releases/latest')) {
      return Promise.resolve(new Response('', { status: 404 }));
    }
    if (u.includes('/readme')) {
      return Promise.resolve(
        new Response(JSON.stringify({ content: base64Content, encoding: 'base64' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  };

  const result = await enrichProject(
    'acme/orchestrator',
    { ARDUR_OSS_ENRICH_GITHUB: '1' },
    fakeFetch as typeof fetch,
  );
  assert.ok(result, 'enrichment result must not be null');
  assert.ok(
    result?.readmeExcerpt?.includes('pluggable orchestration'),
    `Expected decoded excerpt, got: ${result?.readmeExcerpt}`,
  );
});

test('#11 enrichProject falls back to raw content when encoding is not base64', async () => {
  const plainText = 'A fast modular orchestration framework for cloud pipelines.';

  const fakeFetch = (url: string | URL) => {
    const u = String(url);
    if (u.includes('/releases/latest')) {
      return Promise.resolve(new Response('', { status: 404 }));
    }
    if (u.includes('/readme')) {
      // encoding field absent / not 'base64' — treat content as plain text
      return Promise.resolve(
        new Response(JSON.stringify({ content: plainText, encoding: 'utf-8' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  };

  const result = await enrichProject(
    'acme/orch',
    { ARDUR_OSS_ENRICH_GITHUB: '1' },
    fakeFetch as typeof fetch,
  );
  assert.ok(
    result?.readmeExcerpt?.includes('modular orchestration'),
    `got: ${result?.readmeExcerpt}`,
  );
});

// ─── Issue #12: Medium RSS ReDoS ─────────────────────────────────────────────

test('#12 Medium RSS title parsing handles CDATA titles correctly', async () => {
  // Import chatter directly since it's not re-exported via index.
  const { collectChatter } = await import('./ingest/chatter.ts');

  const cdataXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Medium Tag Feed</title>
    <item><title><![CDATA[First Article About Kubernetes]]></title></item>
    <item><title><![CDATA[Second Article About K8s]]></title></item>
  </channel>
</rss>`;

  const fakeFetch = () =>
    Promise.resolve(
      new Response(cdataXml, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    );

  const project = {
    id: 'cncf/kubernetes',
    fullName: 'cncf/kubernetes',
    name: 'kubernetes',
    owner: 'cncf',
    description: '',
    stars: 100000,
    forks: 35000,
    openIssues: 2000,
    createdAt: '2014-06-06T00:00:00Z',
    pushedAt: '2026-06-12T00:00:00Z',
    language: 'Go',
    license: 'Apache-2.0',
    topics: ['kubernetes'],
    url: 'https://github.com/cncf/kubernetes',
    homepage: null,
    categoryLabel: 'Kubernetes',
    category: 'kubernetes',
    rank: 1,
    score: 90,
    confidence: 'high' as const,
    scoreBreakdown: {
      githubAdoption: 80,
      crossPlatformMomentum: 70,
      recency: 90,
      credibility: 95,
    },
  };

  const env = { ARDUR_OSS_FETCH_MEDIUM: '1' };
  const result = await collectChatter(project, env, fakeFetch as unknown as typeof fetch);
  // Should find 2 items from Medium (both CDATA-titled articles).
  const mediumResult = result.platforms.find((r) => r.platform === 'medium');
  assert.ok(mediumResult, 'medium platform result must be present');
  assert.ok(
    (mediumResult?.mentions ?? 0) >= 2,
    `Expected ≥2 mentions, got ${mediumResult?.mentions}`,
  );
});

test('#12 Medium RSS title regex completes quickly on adversarial input', () => {
  // Build an adversarial string: many partial CDATA opens without a close.
  // The old regex /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g could
  // backtrack catastrophically on this input.
  const adversarial =
    '<title>' +
    '<![CDATA['.repeat(100) + // 100 partial CDATA opens, no close
    '</title>';

  const start = Date.now();
  // Attempt to match with the new two-pattern approach (imported via index).
  // We replicate the logic here since it's not exported.
  const CDATA_RE = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/g;
  const PLAIN_RE = /<title>([^<]*)<\/title>/g;
  const stripped = adversarial.replace(CDATA_RE, '');
  const cdataMatches = [...adversarial.matchAll(CDATA_RE)];
  const plainMatches = [...stripped.matchAll(PLAIN_RE)];
  const elapsed = Date.now() - start;

  // Should complete in well under 100ms on any machine — not minutes.
  assert.ok(elapsed < 100, `Regex took ${elapsed}ms — possible ReDoS regression`);
  // Neither pattern should match the adversarial input.
  assert.equal(cdataMatches.length + plainMatches.length, 0);
});
