/**
 * Copyright-safe + provenance gate for project writeups.
 *
 * Reuses the news synthesizer's two ideas:
 *   1. Fact grounding — every non-editorial claim sentence must map to ≥1
 *      `ProjectSignalFact` (via inline [FACT:id] or entity/number overlap).
 *   2. Copyright safety — short quotes only (≤25 words), canonical links on
 *      every fact's provenance, and a credential/secret screen applied to all
 *      text including fact statements and provenance quotes.
 */

import type { ClaimProvenance, Confidence } from '../contracts.ts';
import type { ProjectSignalFact } from '../types.ts';
import { safePublicUrl } from '../util.ts';

export const MAX_QUOTE_WORDS = 25;

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'be',
  'this',
  'that',
  'it',
  'its',
  'as',
  'at',
  'by',
  'from',
  'has',
  'have',
]);

export interface ClaimInput {
  blockIndex: number;
  text: string;
  isEditorial: boolean;
}

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\[fact:[^\]]+\]/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

export function extractInlineCitations(text: string): string[] {
  return [...text.matchAll(/\[FACT:([^\]]+)\]/g)].map((m) => m[1] ?? '').filter(Boolean);
}

/**
 * CJK-aware word count. Each CJK ideograph counts as one word (they are
 * self-delimiting and do not use whitespace between words).
 * Non-CJK tokens are counted by whitespace splitting.
 * Prevents adversarial long CJK strings from bypassing the MAX_QUOTE_WORDS limit.
 */
export function countWords(text: string): number {
  // CJK ideographs are self-delimiting; each character counts as one word.
  // Ranges with /u flag: CJK Radicals (2E80-2EFF), CJK Unified + Kana (3000-9FFF),
  // Yi (A000-AFFF), CJK Compat (F900-FAFF), CJK Compat Forms (FE30-FE4F).
  const CJK_RE =
    /[\u{2E80}-\u{2EFF}\u{3000}-\u{9FFF}\u{A000}-\u{AFFF}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}]/gu;
  const cjkCount = (text.match(CJK_RE) ?? []).length;
  const latinCount = text
    .replace(CJK_RE, '')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0).length;
  return cjkCount + latinCount;
}

export interface ProvenanceResult {
  claims: ClaimProvenance[];
  ungroundedClaims: ClaimInput[];
  isGrounded: boolean;
}

/** Map each claim sentence to supporting facts; flag ungrounded non-editorial claims. */
export function buildProvenanceFromFacts(
  claims: readonly ClaimInput[],
  facts: readonly ProjectSignalFact[],
): ProvenanceResult {
  const factById = new Map(facts.map((f) => [f.id, f]));
  const resultClaims: ClaimProvenance[] = [];
  const ungroundedClaims: ClaimInput[] = [];

  for (const claim of claims) {
    if (claim.isEditorial) {
      resultClaims.push({
        blockIndex: claim.blockIndex,
        text: claim.text,
        isEditorial: true,
        factIds: [],
        corroboration: 0,
        confidence: 'high',
      });
      continue;
    }

    const cited = extractInlineCitations(claim.text).filter((id) => factById.has(id));
    const supporting: string[] = [...cited];

    if (supporting.length === 0 && facts.length > 0) {
      const claimTokens = contentTokens(claim.text);
      const threshold = Math.max(2, Math.ceil(claimTokens.size * 0.25));
      for (const fact of facts) {
        const factTokens = contentTokens(
          `${fact.statement} ${fact.entities.join(' ')} ${fact.quantity?.metric ?? ''}`,
        );
        const overlap = [...factTokens].filter((t) => claimTokens.has(t)).length;
        if (overlap >= threshold) supporting.push(fact.id);
      }
    }

    if (supporting.length === 0) ungroundedClaims.push(claim);

    const domains = new Set<string>();
    for (const id of supporting) {
      const fact = factById.get(id);
      for (const p of fact?.provenance ?? []) domains.add(p.url);
    }
    const confidence: Confidence =
      supporting.length === 0 ? 'low' : domains.size >= 2 ? 'high' : 'medium';

    resultClaims.push({
      blockIndex: claim.blockIndex,
      text: claim.text,
      isEditorial: false,
      factIds: [...new Set(supporting)],
      corroboration: domains.size,
      confidence,
    });
  }

  return { claims: resultClaims, ungroundedClaims, isGrounded: ungroundedClaims.length === 0 };
}

export interface CopyrightViolation {
  kind: 'quote-too-long' | 'missing-canonical-link' | 'credential-leak';
  detail: string;
}

export interface CopyrightVerdict {
  ok: boolean;
  violations: CopyrightViolation[];
}

/** Enforce short-quote, canonical-link, and credential-screen rules on a writeup. */
export function enforceCopyright(
  text: string,
  facts: readonly ProjectSignalFact[],
): CopyrightVerdict {
  const violations: CopyrightViolation[] = [];

  for (const fact of facts) {
    for (const prov of fact.provenance) {
      if (prov.quote) {
        const wc = countWords(prov.quote.trim());
        // Off-by-one fix: allow exactly MAX_QUOTE_WORDS; reject strictly more.
        if (wc > MAX_QUOTE_WORDS) {
          violations.push({
            kind: 'quote-too-long',
            detail: `fact ${fact.id} carries a quote of ${wc} words (limit ${MAX_QUOTE_WORDS})`,
          });
        }
      }
      // URL must be a safe, credential-free public http(s) URL.
      if (!safePublicUrl(prov.url)) {
        violations.push({
          kind: 'missing-canonical-link',
          detail: `fact ${fact.id} provenance is missing a canonical URL`,
        });
      }
    }
  }

  // Credential screen covers model prose + all fact statements + provenance quotes.
  const allText = [
    text,
    ...facts.map((f) => f.statement),
    ...facts.flatMap((f) => f.provenance.map((p) => p.quote ?? '')),
  ].join(' ');

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(allText)) {
      violations.push({
        kind: 'credential-leak',
        detail: 'potential credential/secret detected in writeup text',
      });
      break;
    }
  }

  return { ok: violations.length === 0, violations };
}
