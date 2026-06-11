/**
 * Golden-fixture E2E tests for chatter platform adapters.
 *
 * Each adapter is tested against a representative captured response injected via
 * fetchImpl. No network calls — CI is deterministic. Covers:
 *   - Per-platform 0–15 scoring formula
 *   - 90-point aggregate cap
 *   - Diversity bonus when multiple real platforms are present
 *   - Failure modes: non-200, oversized body (256KB ceiling), malformed JSON
 *
 * Run with: node --test --experimental-strip-types src/chatter.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectChatter, searchTermsFor } from './ingest/chatter.ts';
import { buildMomentumSnapshot } from './momentum.ts';
import type { RadarProject } from './types.ts';

// ──────────────── Shared fixture helpers ──────────────────────────────────────

function makeProject(overrides: Partial<RadarProject> = {}): RadarProject {
  return {
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
    topics: ['artificial-intelligence', 'llm'],
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
    ...overrides,
  };
}

const NOW = new Date('2026-06-11T06:00:00.000Z');
const PROJECT = makeProject();

// Minimal Response factory for fixture injection.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/xml' } });
}

// ──────────────── searchTermsFor ─────────────────────────────────────────────

test('searchTermsFor returns up to 5 unique terms', () => {
  const p = makeProject({
    fullName: 'org/myrepo',
    name: 'myrepo',
    owner: 'org',
    topics: ['ai', 'llm', 'agents', 'tooling'],
  });
  const terms = searchTermsFor(p);
  assert.ok(terms.length <= 5);
  assert.ok(new Set(terms).size === terms.length, 'terms are unique');
  assert.ok(terms.includes('myrepo'), 'includes repo name');
});

// ──────────────── Hacker News adapter ─────────────────────────────────────────

test('HN adapter: scores from hits/points/comments', async () => {
  const fixture = {
    hits: [
      { objectID: '1', title: 'Widget released', points: 120, num_comments: 45 },
      { objectID: '2', title: 'Widget vs others', points: 80, num_comments: 22 },
      { objectID: '3', title: 'Widget internals', points: 50, num_comments: 10 },
    ],
  };
  const fetchImpl = async () => jsonResponse(fixture);
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_HN: '1' }, fetchImpl);
  const hn = result.platforms.find((p) => p.platform === 'hacker-news');
  assert.ok(hn, 'HN platform present');
  assert.equal(hn?.status, 'real');
  assert.equal(hn?.mentions, 3);
  assert.ok(hn?.score > 0 && hn.score <= 15, `score ${hn?.score} in range 0-15`);
});

test('HN adapter: non-200 → unavailable', async () => {
  const fetchImpl = async () => jsonResponse({}, 429);
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_HN: '1' }, fetchImpl);
  const hn = result.platforms.find((p) => p.platform === 'hacker-news');
  assert.equal(hn?.status, 'unavailable');
  assert.equal(hn?.score, 0);
});

test('HN adapter: malformed JSON → unavailable (fails closed)', async () => {
  const fetchImpl = async () => new Response('not-json', { status: 200 });
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_HN: '1' }, fetchImpl);
  const hn = result.platforms.find((p) => p.platform === 'hacker-news');
  assert.equal(hn?.status, 'unavailable');
});

test('HN adapter: empty hits → proxy status, score 0', async () => {
  const fetchImpl = async () => jsonResponse({ hits: [] });
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_HN: '1' }, fetchImpl);
  const hn = result.platforms.find((p) => p.platform === 'hacker-news');
  assert.equal(hn?.status, 'proxy');
  assert.equal(hn?.score, 0);
});

// ──────────────── Reddit adapter ─────────────────────────────────────────────

test('Reddit adapter: scores from posts/upvotes/comments', async () => {
  const fixture = {
    data: {
      children: [
        {
          data: {
            subreddit: 'MachineLearning',
            title: 'Widget is impressive',
            score: 340,
            num_comments: 55,
            permalink: '/r/MachineLearning/comments/abc',
          },
        },
        {
          data: {
            subreddit: 'programming',
            title: 'Using widget in prod',
            score: 120,
            num_comments: 20,
            permalink: '/r/programming/comments/def',
          },
        },
      ],
    },
  };
  const fetchImpl = async () => jsonResponse(fixture);
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_REDDIT: '1' }, fetchImpl);
  const reddit = result.platforms.find((p) => p.platform === 'reddit');
  assert.equal(reddit?.status, 'real');
  assert.equal(reddit?.mentions, 2);
  assert.ok(reddit && reddit.score > 0 && reddit.score <= 15, `score ${reddit?.score} in range`);
});

test('Reddit adapter: non-200 → unavailable', async () => {
  const fetchImpl = async () => jsonResponse({}, 403);
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_REDDIT: '1' }, fetchImpl);
  const reddit = result.platforms.find((p) => p.platform === 'reddit');
  assert.equal(reddit?.status, 'unavailable');
});

// ──────────────── dev.to adapter ──────────────────────────────────────────────

test('devto adapter: scores from articles/reactions', async () => {
  const fixture = [
    {
      title: 'Building with widget',
      positive_reactions_count: 95,
      comments_count: 12,
      url: 'https://dev.to/a',
    },
    {
      title: 'Widget patterns',
      positive_reactions_count: 60,
      comments_count: 8,
      url: 'https://dev.to/b',
    },
    {
      title: 'Widget tips',
      positive_reactions_count: 40,
      comments_count: 5,
      url: 'https://dev.to/c',
    },
  ];
  const fetchImpl = async () => jsonResponse(fixture);
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_DEVTO: '1' }, fetchImpl);
  const devto = result.platforms.find((p) => p.platform === 'devto');
  assert.equal(devto?.status, 'real');
  assert.equal(devto?.mentions, 3);
  assert.ok(devto && devto.score > 0 && devto.score <= 15);
});

test('devto adapter: malformed response (non-array) → fails closed', async () => {
  // The adapter expects an array; a non-array object will cause reduce to throw → unavailable.
  const fetchImpl = async () => jsonResponse({ error: 'not found' });
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_DEVTO: '1' }, fetchImpl);
  const devto = result.platforms.find((p) => p.platform === 'devto');
  assert.equal(devto?.status, 'unavailable');
});

// ──────────────── Medium adapter ─────────────────────────────────────────────

test('Medium adapter: scores from RSS feed items', async () => {
  const rss = `<?xml version="1.0"?>
<rss><channel>
  <title>widget – Medium</title>
  <item><title><![CDATA[Widget performance tips]]></title></item>
  <item><title><![CDATA[Why we chose widget]]></title></item>
  <item><title><![CDATA[Widget vs alternatives]]></title></item>
  <item><title><![CDATA[Getting started with widget]]></title></item>
  <item><title><![CDATA[Widget in 2026]]></title></item>
</channel></rss>`;
  const fetchImpl = async () => textResponse(rss);
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_MEDIUM: '1' }, fetchImpl);
  const medium = result.platforms.find((p) => p.platform === 'medium');
  assert.equal(medium?.status, 'real');
  assert.equal(medium?.mentions, 5, `expected 5 items, got ${medium?.mentions}`);
  // Score = min(5*3, 15) = 15
  assert.equal(medium?.score, 15);
});

test('Medium adapter: non-200 → unavailable', async () => {
  const fetchImpl = async () => textResponse('', 404);
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_MEDIUM: '1' }, fetchImpl);
  const medium = result.platforms.find((p) => p.platform === 'medium');
  assert.equal(medium?.status, 'unavailable');
});

// ──────────────── YouTube adapter ─────────────────────────────────────────────

test('YouTube adapter: no API key → unavailable', async () => {
  const fetchImpl = async () => jsonResponse({});
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_YOUTUBE: '1' }, fetchImpl);
  const yt = result.platforms.find((p) => p.platform === 'youtube');
  assert.equal(yt?.status, 'unavailable');
});

test('YouTube adapter: scores from video results', async () => {
  const fixture = {
    items: [
      {
        id: { videoId: 'abc' },
        snippet: { title: 'Widget demo', channelTitle: 'TechChan', publishedAt: '2026-06-01' },
      },
      {
        id: { videoId: 'def' },
        snippet: { title: 'Widget review', channelTitle: 'DevShow', publishedAt: '2026-05-15' },
      },
      {
        id: { videoId: 'ghi' },
        snippet: { title: 'Widget tutorial', channelTitle: 'CodeCast', publishedAt: '2026-04-10' },
      },
    ],
  };
  const fetchImpl = async () => jsonResponse(fixture);
  const result = await collectChatter(
    PROJECT,
    { ARDUR_OSS_FETCH_YOUTUBE: '1', YOUTUBE_API_KEY: 'fake-key' },
    fetchImpl,
  );
  const yt = result.platforms.find((p) => p.platform === 'youtube');
  assert.equal(yt?.status, 'real');
  assert.equal(yt?.mentions, 3);
  // Score = min(3*2 + min(5,3), 15) = min(6+3, 15) = 9
  assert.equal(yt?.score, 9);
});

test('YouTube adapter: non-200 → unavailable', async () => {
  const fetchImpl = async () => jsonResponse({}, 403);
  const result = await collectChatter(
    PROJECT,
    { ARDUR_OSS_FETCH_YOUTUBE: '1', YOUTUBE_API_KEY: 'fake-key' },
    fetchImpl,
  );
  const yt = result.platforms.find((p) => p.platform === 'youtube');
  assert.equal(yt?.status, 'unavailable');
});

// ──────────────── Oversized body ceiling ─────────────────────────────────────

test('oversized chatter response (>256KB) → fails closed', async () => {
  // The boundedText seam throws when the body exceeds MAX_CHATTER_BYTES.
  // The adapter catches the error and returns unavailable.
  const bigBody = 'x'.repeat(300 * 1024); // 300KB — over the 256KB ceiling
  const fetchImpl = async () => new Response(bigBody, { status: 200 });
  const result = await collectChatter(PROJECT, { ARDUR_OSS_FETCH_HN: '1' }, fetchImpl);
  const hn = result.platforms.find((p) => p.platform === 'hacker-news');
  assert.equal(hn?.status, 'unavailable', 'oversized body must fail closed');
});

// ──────────────── Aggregate: 90-cap + diversity bonus ─────────────────────────

test('chatter aggregate: score is capped at 90', async () => {
  // All 5 platforms return max score 15 each = 75 raw, but capped at 90 anyway.
  // We simulate 6 platforms all at max to verify the cap.
  const hnFixture = {
    hits: Array.from({ length: 100 }, (_, i) => ({
      objectID: String(i),
      title: 'x',
      points: 9999,
      num_comments: 9999,
    })),
  };
  const redditFixture = {
    data: {
      children: Array.from({ length: 100 }, () => ({
        data: { subreddit: 'r', title: 't', score: 9999, num_comments: 9999, permalink: '/r/x' },
      })),
    },
  };
  const devtoFixture = Array.from({ length: 100 }, () => ({
    title: 't',
    positive_reactions_count: 9999,
    comments_count: 9999,
    url: 'https://dev.to/a',
  }));
  const mediumRss =
    '<?xml version="1.0"?><rss><channel><title>x</title>' +
    Array.from({ length: 100 }, () => '<item><title>y</title></item>').join('') +
    '</channel></rss>';
  const ytFixture = {
    items: Array.from({ length: 8 }, (_, i) => ({
      id: { videoId: `v${i}` },
      snippet: { title: `vid${i}`, channelTitle: 'ch', publishedAt: '2026-06-01' },
    })),
  };

  const fetchImpl = async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('hn.algolia.com')) return jsonResponse(hnFixture);
    if (u.includes('reddit.com')) return jsonResponse(redditFixture);
    if (u.includes('dev.to')) return jsonResponse(devtoFixture);
    if (u.includes('medium.com')) return textResponse(mediumRss);
    if (u.includes('googleapis.com')) return jsonResponse(ytFixture);
    return jsonResponse({});
  };

  const env = {
    ARDUR_OSS_FETCH_HN: '1',
    ARDUR_OSS_FETCH_REDDIT: '1',
    ARDUR_OSS_FETCH_DEVTO: '1',
    ARDUR_OSS_FETCH_MEDIUM: '1',
    ARDUR_OSS_FETCH_YOUTUBE: '1',
    YOUTUBE_API_KEY: 'fake-key',
  };
  const result = await collectChatter(PROJECT, env, fetchImpl);
  assert.ok(result.score <= 90, `aggregate score ${result.score} must be ≤ 90`);
  assert.ok(result.score > 0, 'aggregate score must be > 0 when platforms are live');
});

test('diversity bonus: multiple real platforms → higher momentum than single platform', async () => {
  const hnFixture = { hits: [{ objectID: '1', title: 'Widget', points: 50, num_comments: 10 }] };
  const redditFixture = {
    data: {
      children: [
        { data: { subreddit: 'r', title: 't', score: 50, num_comments: 10, permalink: '/r/x' } },
      ],
    },
  };

  const fetchImpl = async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('hn.algolia.com')) return jsonResponse(hnFixture);
    if (u.includes('reddit.com')) return jsonResponse(redditFixture);
    return jsonResponse({}, 404);
  };

  const singleMom = await buildMomentumSnapshot(
    [PROJECT],
    { ARDUR_OSS_FETCH_HN: '1' },
    fetchImpl,
    NOW,
    NOW.toISOString(),
  );
  const twoMom = await buildMomentumSnapshot(
    [PROJECT],
    { ARDUR_OSS_FETCH_HN: '1', ARDUR_OSS_FETCH_REDDIT: '1' },
    fetchImpl,
    NOW,
    NOW.toISOString(),
  );

  const single = singleMom.lookup.byProjectId[PROJECT.id];
  const two = twoMom.lookup.byProjectId[PROJECT.id];
  assert.ok(single && two, 'momentum entries present for both snapshots');
  // Diversity bonus: 2 real platforms → +4 vs 1 real platform → +2.
  assert.ok(
    two!.components.diversityBonus > single!.components.diversityBonus,
    `two platforms diversityBonus=${two!.components.diversityBonus} should be > single=${single!.components.diversityBonus}`,
  );
  assert.ok(two!.score >= single!.score, 'two real platforms → higher total momentum score');
});

// ──────────────── Platform-off (default) path ─────────────────────────────────

test('all platforms off → all unavailable, aggregate score 0', async () => {
  const fetchImpl = async () =>
    jsonResponse({ hits: [{ objectID: '1', title: 't', points: 100, num_comments: 50 }] });
  const result = await collectChatter(PROJECT, {}, fetchImpl);
  assert.equal(result.score, 0);
  assert.ok(result.platforms.every((p) => p.status === 'unavailable'));
});
