/**
 * Bounded, env-gated GitHub enrichment — reads latest release + README excerpt
 * for the Top-10 projects to supply richer ProjectSignalFacts for writeup grounding.
 *
 * Opt-in only: ARDUR_OSS_ENRICH_GITHUB=1 (or GITHUB_TOKEN/GH_TOKEN present).
 * Off by default — CI and deterministic cycles make zero network calls.
 */

import { boundedText, envFlag, safePublicUrl } from '../util.ts';

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
 * Validate that fullName has the safe "owner/repo" shape before URL interpolation.
 * Guards against SSRF, path traversal, and header injection (CWE-918, CWE-22, CWE-88).
 */
function validateFullName(fullName: string): boolean {
  return (
    /^[a-zA-Z0-9._-]{1,100}\/[a-zA-Z0-9._-]{1,100}$/.test(fullName) && !fullName.includes('..')
  );
}

/** Build a safe GitHub API URL from a validated fullName (percent-encodes each segment). */
function buildRepoUrl(fullName: string, suffix: string): string {
  const slash = fullName.indexOf('/');
  const owner = encodeURIComponent(fullName.slice(0, slash));
  const repo = encodeURIComponent(fullName.slice(slash + 1));
  return `https://api.github.com/repos/${owner}/${repo}/${suffix}`;
}

/**
 * Extract a short, copyright-safe README excerpt (≤25 words, ≤160 chars).
 * Accepts already-decoded plain text — the caller decodes base64 via the API
 * encoding field, so no heuristic is needed here.
 */
function extractReadmeExcerpt(text: string): string | null {
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

  // Take first non-empty sentence (ends with . ! ?) that has ≥4 words.
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
    const res = await fetchImpl(buildRepoUrl(fullName, 'releases/latest'), {
      headers,
      redirect: 'error', // prevent Bearer token from following cross-origin redirects (CWE-918)
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
      url: safePublicUrl(data.html_url) ?? `https://github.com/${fullName}/releases/latest`,
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
    const res = await fetchImpl(buildRepoUrl(fullName, 'readme'), {
      headers,
      redirect: 'error',
    });
    if (!res.ok) return null;
    const raw = await boundedText(res, README_MAX_BYTES);
    const data = JSON.parse(raw) as { content?: string; encoding?: string };
    if (!data.content) return null;
    // Honor the API's encoding field (#11) instead of guessing from content shape.
    const decoded =
      data.encoding === 'base64'
        ? Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf-8')
        : data.content;
    return extractReadmeExcerpt(decoded);
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
  if (!validateFullName(fullName)) return null; // SSRF input gate (CWE-918/CWE-22)

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
