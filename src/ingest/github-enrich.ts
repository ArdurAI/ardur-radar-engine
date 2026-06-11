/**
 * Bounded, env-gated GitHub enrichment — reads latest release + README excerpt
 * for the Top-10 projects to supply richer ProjectSignalFacts for writeup grounding.
 *
 * Opt-in only: ARDUR_OSS_ENRICH_GITHUB=1 (or GITHUB_TOKEN/GH_TOKEN present).
 * Off by default — CI and deterministic cycles make zero network calls.
 */

import { boundedText, envFlag } from '../util.ts';

const README_MAX_BYTES = 64 * 1024; // 64 KB
const RELEASE_MAX_BYTES = 32 * 1024; // 32 KB
const README_EXCERPT_MAX_WORDS = 25;
const README_EXCERPT_MAX_CHARS = 160;

export interface ReleaseEnrichment {
  tag: string;
  publishedAt: string;
  url: string;
}

export interface ProjectEnrichment {
  fullName: string;
  release: ReleaseEnrichment | null;
  readmeExcerpt: string | null;
}

/** True when enrichment network calls are enabled. */
export function enrichmentEnabled(env: NodeJS.ProcessEnv): boolean {
  if (envFlag(env, 'ARDUR_OSS_ENRICH_GITHUB')) return true;
  if (env.GITHUB_TOKEN || env.GH_TOKEN) return true;
  return false;
}

function buildHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/**
 * Extract a short, copyright-safe README excerpt (≤25 words, ≤160 chars).
 * Strips markdown, takes the first substantive sentence from the first paragraph.
 */
function extractReadmeExcerpt(raw: string): string | null {
  // Decode base64 content returned by the GitHub API.
  let text = raw;
  try {
    if (/^[A-Za-z0-9+/\s]+=*$/.test(raw.slice(0, 100))) {
      text = Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf-8');
    }
  } catch {
    // Treat raw as plain text.
  }

  // Strip markdown: headings, badges, links, bold/italic, code spans.
  const clean = text
    .replace(/^#.*$/gm, '') // headings
    .replace(/!\[.*?\]\(.*?\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → link text
    .replace(/`[^`]*`/g, '') // inline code
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .replace(/<!--.*?-->/gs, '') // HTML comments
    .replace(/<[^>]+>/g, '') // HTML tags
    .replace(/\s+/g, ' ')
    .trim();

  // Take first non-empty sentence (ends with . ! ?) that has ≥6 words.
  const sentences = clean.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const t = s.trim();
    if (t.length < 10) continue;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 4) continue;
    // Truncate to the word limit, then char limit.
    const truncated = words.slice(0, README_EXCERPT_MAX_WORDS).join(' ');
    const final =
      truncated.length > README_EXCERPT_MAX_CHARS
        ? truncated.slice(0, README_EXCERPT_MAX_CHARS).replace(/\s+\S*$/, '') + '…'
        : truncated;
    return final;
  }
  return null;
}

/** Fetch the latest release for one project. Returns null on any error. */
async function fetchLatestRelease(
  fullName: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ReleaseEnrichment | null> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${fullName}/releases/latest`, {
      headers,
    });
    if (!res.ok) return null;
    const raw = await boundedText(res, RELEASE_MAX_BYTES);
    const data = JSON.parse(raw) as {
      tag_name?: string;
      published_at?: string;
      html_url?: string;
    };
    if (!data.tag_name || !data.published_at) return null;
    return {
      tag: data.tag_name,
      publishedAt: data.published_at,
      url: data.html_url ?? `https://github.com/${fullName}/releases/latest`,
    };
  } catch {
    return null;
  }
}

/** Fetch the README excerpt for one project. Returns null on any error. */
async function fetchReadmeExcerpt(
  fullName: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${fullName}/readme`, { headers });
    if (!res.ok) return null;
    const raw = await boundedText(res, README_MAX_BYTES);
    const data = JSON.parse(raw) as { content?: string; encoding?: string };
    if (!data.content) return null;
    return extractReadmeExcerpt(data.content);
  } catch {
    return null;
  }
}

/** Enrich one project with release + README facts (no-op when not enabled). */
export async function enrichProject(
  fullName: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ProjectEnrichment | null> {
  if (!enrichmentEnabled(env)) return null;

  const headers = buildHeaders(env);
  const [release, readmeExcerpt] = await Promise.all([
    fetchLatestRelease(fullName, headers, fetchImpl),
    fetchReadmeExcerpt(fullName, headers, fetchImpl),
  ]);
  return { fullName, release, readmeExcerpt };
}

/** Enrich all projects concurrently (bounded fan-out). */
export async function enrichProjects(
  fullNames: string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Map<string, ProjectEnrichment>> {
  if (!enrichmentEnabled(env) || fullNames.length === 0) return new Map();

  const results = await Promise.all(fullNames.map((name) => enrichProject(name, env, fetchImpl)));
  const map = new Map<string, ProjectEnrichment>();
  for (const r of results) {
    if (r) map.set(r.fullName, r);
  }
  return map;
}
