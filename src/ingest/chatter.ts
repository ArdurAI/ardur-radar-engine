/**
 * Cross-platform chatter adapters — ports `oss-chatter-sources.mjs`.
 *
 * Every adapter is OFF by default (deterministic, no network). A platform fetches
 * live only when its `ARDUR_OSS_FETCH_*` flag is set. Each adapter returns a
 * bounded 0–15 platform score; the aggregate is capped at 90 with a per-platform
 * diversity signal computed downstream in `momentum.ts`.
 */

import type {
  RadarProject,
  ChatterPlatform,
  ChatterPlatformResult,
  ChatterResult,
} from '../types.ts';
import { boundedText, clamp, envFlag, log10p1, safePublicUrl, unique } from '../util.ts';

const MAX_CHATTER_BYTES = 256 * 1024;
const PLATFORM_MAX = 15;
const UNAVAILABLE = '[FILL: platform chatter unavailable]';

/** Up to 5 search terms derived from a project, ported from the in-ardur.ai logic. */
export function searchTermsFor(project: RadarProject): string[] {
  const repoPart = project.fullName.split('/')[1] ?? project.name;
  return unique([
    project.fullName,
    project.name,
    repoPart,
    project.owner,
    ...project.topics.slice(0, 4),
  ]).slice(0, 5);
}

function unavailable(platform: ChatterPlatform): ChatterPlatformResult {
  return {
    platform,
    mentions: 0,
    score: 0,
    status: 'unavailable',
    signals: [],
    realMetrics: [],
    unavailableMetrics: [UNAVAILABLE],
  };
}

type Adapter = (
  project: RadarProject,
  terms: string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
) => Promise<ChatterPlatformResult>;

async function fetchHackerNews(
  _project: RadarProject,
  terms: string[],
  _env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ChatterPlatformResult> {
  const term = terms[0] ?? '';
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(term)}&tags=story&hitsPerPage=8`;
  const res = await fetchImpl(url);
  if (!res.ok) return unavailable('hacker-news');
  const data = JSON.parse(await boundedText(res, MAX_CHATTER_BYTES)) as {
    hits?: Array<{
      objectID: string;
      title?: string;
      points?: number;
      num_comments?: number;
      url?: string;
    }>;
  };
  const hits = data.hits ?? [];
  const points = hits.reduce((s, h) => s + (h.points ?? 0), 0);
  const comments = hits.reduce((s, h) => s + (h.num_comments ?? 0), 0);
  const score = clamp(hits.length * 2 + log10p1(points) * 2 + log10p1(comments), PLATFORM_MAX);
  return {
    platform: 'hacker-news',
    mentions: hits.length,
    score,
    status: hits.length > 0 ? 'real' : 'proxy',
    signals: hits.slice(0, 3).map((h) => `HN: ${h.title ?? 'story'} (${h.points ?? 0} pts)`),
    realMetrics: hits.map((h) => ({
      type: 'hacker_news_story',
      objectId: h.objectID,
      title: h.title,
      points: h.points ?? 0,
      comments: h.num_comments ?? 0,
      url: safePublicUrl(h.url) ?? undefined, // #15: sanitize story URLs from API.
    })),
    unavailableMetrics: [],
  };
}

async function fetchReddit(
  _project: RadarProject,
  terms: string[],
  _env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ChatterPlatformResult> {
  const term = terms[0] ?? '';
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(term)}&limit=8&sort=relevance`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'ardur-radar-engine' } });
  if (!res.ok) return unavailable('reddit');
  const data = JSON.parse(await boundedText(res, MAX_CHATTER_BYTES)) as {
    data?: {
      children?: Array<{
        data: {
          subreddit: string;
          title: string;
          score: number;
          num_comments: number;
          permalink: string;
        };
      }>;
    };
  };
  const posts = (data.data?.children ?? []).map((c) => c.data);
  const scoreTotal = posts.reduce((s, p) => s + (p.score ?? 0), 0);
  const comments = posts.reduce((s, p) => s + (p.num_comments ?? 0), 0);
  const score = clamp(posts.length * 2 + log10p1(scoreTotal) * 2 + log10p1(comments), PLATFORM_MAX);
  return {
    platform: 'reddit',
    mentions: posts.length,
    score,
    status: posts.length > 0 ? 'real' : 'proxy',
    signals: posts.slice(0, 3).map((p) => `r/${p.subreddit}: ${p.title} (${p.score} pts)`),
    realMetrics: posts.map((p) => ({
      type: 'reddit_post',
      subreddit: p.subreddit,
      title: p.title,
      score: p.score,
      comments: p.num_comments,
      url: `https://www.reddit.com${p.permalink}`,
    })),
    unavailableMetrics: [],
  };
}

async function fetchDevTo(
  project: RadarProject,
  _terms: string[],
  _env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ChatterPlatformResult> {
  const tag = (project.topics[0] ?? project.name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const url = `https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&per_page=8`;
  const res = await fetchImpl(url);
  if (!res.ok) return unavailable('devto');
  const articles = JSON.parse(await boundedText(res, MAX_CHATTER_BYTES)) as Array<{
    title: string;
    positive_reactions_count?: number;
    comments_count?: number;
    url: string;
  }>;
  const reactions = articles.reduce((s, a) => s + (a.positive_reactions_count ?? 0), 0);
  const score = clamp(articles.length * 2 + log10p1(reactions) * 2, PLATFORM_MAX);
  return {
    platform: 'devto',
    mentions: articles.length,
    score,
    status: articles.length > 0 ? 'real' : 'proxy',
    signals: articles.slice(0, 3).map((a) => `dev.to: ${a.title}`),
    realMetrics: articles.map((a) => ({
      type: 'devto_article',
      title: a.title,
      reactions: a.positive_reactions_count ?? 0,
      comments: a.comments_count ?? 0,
      url: a.url,
    })),
    unavailableMetrics: [],
  };
}

async function fetchMedium(
  project: RadarProject,
  _terms: string[],
  _env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ChatterPlatformResult> {
  const tag = (project.topics[0] ?? project.name).toLowerCase().replace(/[^a-z0-9]/g, '-');
  const url = `https://medium.com/feed/tag/${encodeURIComponent(tag)}`;
  const res = await fetchImpl(url);
  if (!res.ok) return unavailable('medium');
  const xml = await boundedText(res, MAX_CHATTER_BYTES);
  // Two explicit, non-backtracking patterns replace the ambiguous combined optional
  // (?:<!\[CDATA\[)?(.*?)(?:\]\]>)? that invited catastrophic backtracking (ReDoS).
  const CDATA_TITLE_RE = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/g;
  const PLAIN_TITLE_RE = /<title>([^<]*)<\/title>/g;
  const stripped = xml.replace(CDATA_TITLE_RE, ''); // remove CDATA blocks before plain pass
  const titles = [
    ...[...xml.matchAll(CDATA_TITLE_RE)].map((m) => m[1] ?? ''),
    ...[...stripped.matchAll(PLAIN_TITLE_RE)].map((m) => m[1] ?? ''),
  ];
  const items = titles.slice(1); // first <title> is the feed itself
  const score = clamp(items.length * 3, PLATFORM_MAX);
  return {
    platform: 'medium',
    mentions: items.length,
    score,
    status: items.length > 0 ? 'real' : 'proxy',
    signals: items.slice(0, 3).map((t) => `Medium: ${t}`),
    realMetrics: items.map((t) => ({ type: 'medium_article', title: t })),
    unavailableMetrics: [],
  };
}

async function fetchYouTube(
  _project: RadarProject,
  terms: string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ChatterPlatformResult> {
  const apiKey = env['YOUTUBE_API_KEY'];
  if (!apiKey) return unavailable('youtube');
  const term = terms[0] ?? '';
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(term)}&key=${apiKey}`;
  const res = await fetchImpl(url, { redirect: 'error' }); // #19: key-in-URL, block redirects.
  if (!res.ok) return unavailable('youtube');
  const data = JSON.parse(await boundedText(res, MAX_CHATTER_BYTES)) as {
    items?: Array<{
      id: { videoId?: string };
      snippet: { title: string; channelTitle: string; publishedAt: string };
    }>;
  };
  const items = data.items ?? [];
  const score = clamp(items.length * 2 + Math.min(5, items.length), PLATFORM_MAX);
  return {
    platform: 'youtube',
    mentions: items.length,
    score,
    status: items.length > 0 ? 'real' : 'proxy',
    signals: items.slice(0, 3).map((v) => `YouTube: ${v.snippet.title}`),
    realMetrics: items.map((v) => ({
      type: 'youtube_video',
      videoId: v.id.videoId,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      publishedAt: v.snippet.publishedAt,
      url: v.id.videoId
        ? (safePublicUrl(`https://www.youtube.com/watch?v=${v.id.videoId}`) ?? undefined) // #15
        : undefined,
    })),
    unavailableMetrics: [],
  };
}

/** X/Twitter requires a paid API; intentionally stubbed as unavailable. */
async function fetchX(): Promise<ChatterPlatformResult> {
  return unavailable('x-stub');
}

const ADAPTERS: Array<{ flag: string; platform: ChatterPlatform; adapter: Adapter }> = [
  { flag: 'ARDUR_OSS_FETCH_HN', platform: 'hacker-news', adapter: fetchHackerNews },
  { flag: 'ARDUR_OSS_FETCH_REDDIT', platform: 'reddit', adapter: fetchReddit },
  { flag: 'ARDUR_OSS_FETCH_DEVTO', platform: 'devto', adapter: fetchDevTo },
  { flag: 'ARDUR_OSS_FETCH_MEDIUM', platform: 'medium', adapter: fetchMedium },
  { flag: 'ARDUR_OSS_FETCH_YOUTUBE', platform: 'youtube', adapter: fetchYouTube },
  { flag: 'ARDUR_OSS_FETCH_X', platform: 'x-stub', adapter: fetchX },
];

/** True when at least one chatter platform is opted into live fetches. */
export function chatterLiveEnabled(env: NodeJS.ProcessEnv): boolean {
  return ADAPTERS.some((a) => envFlag(env, a.flag));
}

/** Collect chatter for one project across all enabled platforms (else unavailable). */
export async function collectChatter(
  project: RadarProject,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ChatterResult> {
  const terms = searchTermsFor(project);
  const platforms: ChatterPlatformResult[] = [];
  for (const { flag, platform, adapter } of ADAPTERS) {
    if (!envFlag(env, flag)) {
      platforms.push(unavailable(platform));
      continue;
    }
    try {
      platforms.push(await adapter(project, terms, env, fetchImpl));
    } catch {
      platforms.push(unavailable(platform));
    }
  }
  const score = clamp(
    platforms.reduce((s, p) => s + p.score, 0),
    90,
  );
  const realMetrics = platforms.flatMap((p) => p.realMetrics);
  const signals = platforms.flatMap((p) => p.signals);
  const unavailableMetrics = platforms.flatMap((p) => p.unavailableMetrics);
  return {
    schemaVersion: 'oss-chatter/v1',
    projectId: project.id,
    searchTerms: terms,
    platforms,
    mentions: platforms.reduce((s, p) => s + p.mentions, 0),
    score,
    max: 90,
    status: realMetrics.length > 0 ? 'real' : 'proxy',
    signals,
    realMetrics,
    unavailableMetrics,
  };
}
