/**
 * Fact-grounded, AI-primary project writeups with HOLD.
 *
 * Facts are derived from the project's OWN signals (GitHub adoption, recency,
 * license, topics — real metadata, never an assumption-y paraphrase). When
 * ARDUR_OSS_ENRICH_GITHUB is set (or GITHUB_TOKEN present), richer facts are
 * appended from the latest release and a short README excerpt. The AI provider
 * writes original prose grounded in those facts; every claim is gated against
 * them. If the provider is unavailable, the prose is ungrounded after one
 * bounded re-ask, or copyright checks fail, the writeup is HELD (never published)
 * rather than shipped on a flat template.
 */

import type { ProviderMeta, SourceRef } from '../contracts.ts';
import type { RankedSignal, ProjectWriteup, ProjectSignalFact } from '../types.ts';
import { ageDays, stableId } from '../util.ts';
import type { AiProvider, WriteupDraft } from './provider.ts';
import { buildProvenanceFromFacts, enforceCopyright, type ClaimInput } from './copyright.ts';
import type { ProjectEnrichment } from '../ingest/github-enrich.ts';

const VOICE_DIRECTIVE =
  'House voice: precise, practitioner-facing, no hype. State only what the signals support.';

/** Derive grounded facts from a project's real GitHub signals (+ optional enrichment). */
export function deriveFacts(
  signal: RankedSignal,
  now: Date,
  enrichment?: ProjectEnrichment | null,
): ProjectSignalFact[] {
  const extractedBy: ProviderMeta = {
    provider: 'deterministic',
    model: 'signal-extract/v1',
    status: 'generated',
    generatedAt: now.toISOString(),
  };
  const facts: ProjectSignalFact[] = [];
  const prov = (kind: string) => [{ kind, url: signal.url }];

  facts.push({
    id: stableId('fact', `${signal.id}:stars`),
    statement: `${signal.fullName} has accumulated ${signal.stars.toLocaleString('en-US')} GitHub stars.`,
    quantity: { metric: 'stars', value: signal.stars, asOf: now.toISOString() },
    entities: [signal.fullName, 'GitHub stars'],
    provenance: prov('github-stargazers'),
    confidence: 'high',
    extractedBy,
  });
  facts.push({
    id: stableId('fact', `${signal.id}:forks`),
    statement: `${signal.name} has ${signal.forks.toLocaleString('en-US')} forks, a proxy for downstream reuse.`,
    quantity: { metric: 'forks', value: signal.forks, asOf: now.toISOString() },
    entities: [signal.name, 'forks'],
    provenance: prov('github-forks'),
    confidence: 'high',
    extractedBy,
  });
  if (signal.pushedAt) {
    const days = Math.round(ageDays(signal.pushedAt, now));
    facts.push({
      id: stableId('fact', `${signal.id}:recency`),
      statement: `${signal.name} last shipped a push ${days} day${days === 1 ? '' : 's'} ago, indicating ${days <= 14 ? 'active' : days <= 90 ? 'steady' : 'slower'} maintenance.`,
      quantity: { metric: 'days-since-push', value: days, unit: 'days', asOf: now.toISOString() },
      entities: [signal.name, 'maintenance cadence'],
      provenance: prov('github-activity'),
      confidence: 'high',
      extractedBy,
    });
  }
  if (signal.license) {
    facts.push({
      id: stableId('fact', `${signal.id}:license`),
      statement: `${signal.name} is distributed under the ${signal.license} license.`,
      entities: [signal.name, signal.license],
      provenance: prov('github-license'),
      confidence: 'high',
      extractedBy,
    });
  }
  if (signal.language) {
    facts.push({
      id: stableId('fact', `${signal.id}:language`),
      statement: `${signal.name} is primarily written in ${signal.language}.`,
      entities: [signal.name, signal.language],
      provenance: prov('github-language'),
      confidence: 'medium',
      extractedBy,
    });
  }

  // Enrichment facts (opt-in, from GitHub releases + README).
  if (enrichment) {
    if (enrichment.release) {
      const rel = enrichment.release;
      const relDays = Math.round(ageDays(rel.publishedAt, now));
      facts.push({
        id: stableId('fact', `${signal.id}:release`),
        statement: `${signal.name} latest release is ${rel.tag}, published ${relDays} day${relDays === 1 ? '' : 's'} ago.`,
        quantity: {
          metric: 'days-since-release',
          value: relDays,
          unit: 'days',
          asOf: now.toISOString(),
        },
        entities: [signal.name, rel.tag, 'release'],
        provenance: [{ kind: 'github-release', url: rel.url }],
        confidence: 'high',
        extractedBy,
      });
    }
    if (enrichment.readmeExcerpt) {
      facts.push({
        id: stableId('fact', `${signal.id}:readme`),
        // Excerpt goes in provenance.quote (checked by copyright gate) rather than
        // embedded verbatim in the statement to avoid serializing third-party text.
        statement: `${signal.name} documents its purpose in the project README.`,
        entities: [signal.name, 'README'],
        provenance: [
          { kind: 'github-readme', url: `${signal.url}#readme`, quote: enrichment.readmeExcerpt },
        ],
        confidence: 'medium',
        extractedBy,
      });
    }
  }

  return facts;
}

/** A grounded but flat deterministic draft — used as the model fallback, never published. */
function buildFallbackDraft(signal: RankedSignal, facts: ProjectSignalFact[]): WriteupDraft {
  const cite = (id: string) => `[FACT:${id}]`;
  const starsFact = facts.find((f) => f.id.includes('stars'));
  const recencyFact = facts.find((f) => f.id.includes('recency'));
  const body = facts
    .slice(0, 3)
    .map((f) => `${f.statement} ${cite(f.id)}`)
    .join(' ');
  return {
    headline: `${signal.name} climbs the OSS radar at #${signal.rank}`,
    dek: `${signal.categoryLabel} · score ${signal.score.toFixed(0)}/100`,
    body,
    whyItMatters: starsFact
      ? `Adoption signal: ${starsFact.statement} ${cite(starsFact.id)}`
      : `Ranked #${signal.rank} in ${signal.categoryLabel}.`,
    readerAction: recencyFact
      ? `Check recent activity before adopting. ${cite(recencyFact.id)}`
      : `Review the project on GitHub before adopting.`,
  };
}

function splitClaims(body: string): ClaimInput[] {
  return body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((text, i) => ({ blockIndex: i, text, isEditorial: false }));
}

function toSourceRefs(signal: RankedSignal, enrichment?: ProjectEnrichment | null): SourceRef[] {
  const refs: SourceRef[] = [
    {
      source: 'GitHub',
      sourceDomain: 'github.com',
      tier: 'primary',
      url: signal.url,
      title: signal.fullName,
      publishedAt: signal.pushedAt ?? signal.createdAt ?? '',
    },
  ];
  if (enrichment?.release) {
    refs.push({
      source: 'GitHub Releases',
      sourceDomain: 'github.com',
      tier: 'primary',
      url: enrichment.release.url,
      title: `${signal.name} ${enrichment.release.tag}`,
      publishedAt: enrichment.release.publishedAt,
    });
  }
  return refs;
}

function held(
  signal: RankedSignal,
  facts: ProjectSignalFact[],
  reason: string,
  ai: ProviderMeta,
  enrichment?: ProjectEnrichment | null,
): ProjectWriteup {
  return {
    projectId: signal.id,
    rank: signal.rank,
    headline: `${signal.name} — writeup held`,
    dek: `${signal.categoryLabel} · #${signal.rank}`,
    body: '',
    whyItMatters: '',
    readerAction: '',
    confidence: 'low',
    editorialStatus: 'held',
    holdReason: reason,
    facts,
    claims: [],
    references: toSourceRefs(signal, enrichment),
    ai,
  };
}

/** Synthesize one project writeup, gating on fact grounding + copyright. */
export async function synthesizeWriteup(
  signal: RankedSignal,
  provider: AiProvider,
  now: Date,
  enrichment?: ProjectEnrichment | null,
): Promise<ProjectWriteup> {
  const facts = deriveFacts(signal, now, enrichment);
  const fallback = buildFallbackDraft(signal, facts);
  const baseRequest = {
    projectId: signal.id,
    projectName: signal.name,
    fullName: signal.fullName,
    category: signal.categoryLabel,
    facts,
    fallback,
    voiceDirective: VOICE_DIRECTIVE,
  };

  if (!provider.canGenerate()) {
    return held(
      signal,
      facts,
      'ai-unavailable',
      {
        provider: 'deterministic',
        model: 'rules/v1',
        status: 'fallback',
        generatedAt: now.toISOString(),
      },
      enrichment,
    );
  }

  let result = await provider.generate(baseRequest);
  // AI-primary: a deterministic/fallback result is held, not flat-published.
  if (result.meta.provider === 'deterministic' || result.meta.status === 'fallback') {
    return held(signal, facts, result.meta.reason ?? 'ai-fallback', result.meta, enrichment);
  }

  let claims = splitClaims(result.draft.body);
  let provenance = buildProvenanceFromFacts(claims, facts);

  if (!provenance.isGrounded && provider.canGenerate()) {
    // One bounded re-ask with the ungrounded sentences.
    result = await provider.generate({
      ...baseRequest,
      reaskClaims: provenance.ungroundedClaims.map((c) => c.text),
    });
    if (result.meta.provider === 'deterministic' || result.meta.status === 'fallback') {
      return held(signal, facts, 'ai-fallback-on-reask', result.meta, enrichment);
    }
    claims = splitClaims(result.draft.body);
    provenance = buildProvenanceFromFacts(claims, facts);
  }

  if (!provenance.isGrounded) {
    return held(signal, facts, 'ungrounded-after-regrounding', result.meta, enrichment);
  }

  const copyright = enforceCopyright(
    [result.draft.body, result.draft.whyItMatters, result.draft.readerAction].join(' '),
    facts,
  );
  if (!copyright.ok) {
    return held(
      signal,
      facts,
      `copyright:${copyright.violations.map((v) => v.kind).join(',')}`,
      result.meta,
      enrichment,
    );
  }

  const corroboration = Math.max(0, ...provenance.claims.map((c) => c.corroboration));
  return {
    projectId: signal.id,
    rank: signal.rank,
    headline: result.draft.headline,
    dek: result.draft.dek,
    body: result.draft.body,
    whyItMatters: result.draft.whyItMatters,
    readerAction: result.draft.readerAction,
    confidence: corroboration >= 2 ? 'high' : 'medium',
    editorialStatus: 'published',
    facts,
    claims: provenance.claims,
    references: toSourceRefs(signal, enrichment),
    ai: result.meta,
  };
}

/** Synthesize writeups for the whole Top-10, with optional per-project enrichment. */
export async function synthesizeWriteups(
  topTen: RankedSignal[],
  provider: AiProvider,
  now: Date,
  enrichments?: Map<string, ProjectEnrichment>,
): Promise<ProjectWriteup[]> {
  const writeups: ProjectWriteup[] = [];
  for (const signal of topTen) {
    const enrichment = enrichments?.get(signal.fullName) ?? null;
    writeups.push(await synthesizeWriteup(signal, provider, now, enrichment));
  }
  return writeups;
}
