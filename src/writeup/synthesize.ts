/**
 * Fact-grounded, AI-primary project writeups with HOLD.
 *
 * Facts are derived from the project's OWN signals (GitHub adoption, recency,
 * license, topics — real metadata, never an assumption-y paraphrase). The AI
 * provider writes original prose grounded in those facts; every claim is gated
 * against them. If the provider is unavailable, the prose is ungrounded after one
 * bounded re-ask, or copyright checks fail, the writeup is HELD (never published)
 * rather than shipped on a flat template.
 */

import type { ProviderMeta, SourceRef } from '../contracts.ts';
import type { RankedSignal, ProjectWriteup, ProjectSignalFact } from '../types.ts';
import { ageDays, stableId } from '../util.ts';
import type { AiProvider, WriteupDraft } from './provider.ts';
import { buildProvenanceFromFacts, enforceCopyright, type ClaimInput } from './copyright.ts';

const VOICE_DIRECTIVE =
  'House voice: precise, practitioner-facing, no hype. State only what the signals support.';

/** Derive grounded facts from a project's real GitHub signals. */
export function deriveFacts(signal: RankedSignal, now: Date): ProjectSignalFact[] {
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

function toSourceRefs(signal: RankedSignal): SourceRef[] {
  return [
    {
      source: 'GitHub',
      sourceDomain: 'github.com',
      tier: 'primary',
      url: signal.url,
      title: signal.fullName,
      publishedAt: signal.pushedAt ?? signal.createdAt ?? '',
    },
  ];
}

function held(
  signal: RankedSignal,
  facts: ProjectSignalFact[],
  reason: string,
  ai: ProviderMeta,
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
    references: toSourceRefs(signal),
    ai,
  };
}

/** Synthesize one project writeup, gating on fact grounding + copyright. */
export async function synthesizeWriteup(
  signal: RankedSignal,
  provider: AiProvider,
  now: Date,
): Promise<ProjectWriteup> {
  const facts = deriveFacts(signal, now);
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
    return held(signal, facts, 'ai-unavailable', {
      provider: 'deterministic',
      model: 'rules/v1',
      status: 'fallback',
      generatedAt: now.toISOString(),
    });
  }

  let result = await provider.generate(baseRequest);
  // AI-primary: a deterministic/fallback result is held, not flat-published.
  if (result.meta.provider === 'deterministic' || result.meta.status === 'fallback') {
    return held(signal, facts, result.meta.reason ?? 'ai-fallback', result.meta);
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
      return held(signal, facts, 'ai-fallback-on-reask', result.meta);
    }
    claims = splitClaims(result.draft.body);
    provenance = buildProvenanceFromFacts(claims, facts);
  }

  if (!provenance.isGrounded) {
    return held(signal, facts, 'ungrounded-after-regrounding', result.meta);
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
    references: toSourceRefs(signal),
    ai: result.meta,
  };
}

/** Synthesize writeups for the whole Top-10. */
export async function synthesizeWriteups(
  topTen: RankedSignal[],
  provider: AiProvider,
  now: Date,
): Promise<ProjectWriteup[]> {
  const writeups: ProjectWriteup[] = [];
  for (const signal of topTen) {
    writeups.push(await synthesizeWriteup(signal, provider, now));
  }
  return writeups;
}
