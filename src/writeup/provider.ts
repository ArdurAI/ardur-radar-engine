/**
 * Cost-guarded, pluggable AI provider for project writeups.
 *
 * Ports the news synthesizer's provider pattern: deterministic by default,
 * Ollama as the primary model path (local-first; cloud only when OLLAMA_API_KEY
 * is set), OpenAI as an optional fallback. A provider NEVER rejects — every
 * failure (timeout, HTTP error, bad JSON, exhausted budget) resolves to the
 * deterministic fallback draft, and the synthesizer decides whether to HOLD.
 */

import type { ProviderMeta } from '../contracts.ts';
import type { ProjectSignalFact } from '../types.ts';
import { envFlag, envInt, boundedText } from '../util.ts';

export type ProviderName = 'deterministic' | 'ollama' | 'openai';

export interface WriteupDraft {
  headline: string;
  dek: string;
  body: string;
  whyItMatters: string;
  readerAction: string;
}

export interface GenerateRequest {
  projectId: string;
  projectName: string;
  fullName: string;
  category: string;
  facts: ProjectSignalFact[];
  /** Deterministic fallback draft (grounded but flat; never published as-is). */
  fallback: WriteupDraft;
  voiceDirective: string;
  /** Claim sentences flagged ungrounded on the first pass, for one bounded re-ask. */
  reaskClaims?: string[];
}

export interface GenerateResult {
  draft: WriteupDraft;
  meta: ProviderMeta;
}

export interface AiProvider {
  readonly name: ProviderName;
  canGenerate(): boolean;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  generationsUsed(): number;
}

export interface ProviderConfig {
  provider?: ProviderName;
  enabled?: boolean;
  maxGenerations?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now: Date;
  fetchImpl?: typeof fetch;
}

/** Build the grounding prompt from the project's own signal facts. */
export function buildPrompt(request: GenerateRequest): string {
  const factLines = request.facts
    .map(
      (f) =>
        `- [FACT:${f.id}] ${f.statement}${f.quantity ? ` (${f.quantity.metric}=${f.quantity.value}${f.quantity.unit ?? ''})` : ''}`,
    )
    .join('\n');
  const reask = request.reaskClaims?.length
    ? `\n\nThe following sentences were NOT grounded in any fact above. Rewrite the writeup so every sentence is supported, or drop them:\n${request.reaskClaims.map((c) => `- ${c}`).join('\n')}`
    : '';
  return [
    request.voiceDirective,
    `Write a short, original radar writeup for the open-source project ${request.fullName} (${request.category}).`,
    'Every factual sentence MUST be grounded in one of these signals and cite it inline as [FACT:id]. Do not invent numbers, releases, or claims.',
    `Signals:\n${factLines}`,
    'Return strict JSON: {"headline","dek","body","whyItMatters","readerAction"}. The "body" is 2–4 grounded sentences.',
    reask,
  ].join('\n\n');
}

class DeterministicProvider implements AiProvider {
  readonly name: ProviderName = 'deterministic';
  private readonly now: Date;
  constructor(now: Date) {
    this.now = now;
  }
  canGenerate(): boolean {
    return true;
  }
  generationsUsed(): number {
    return 0;
  }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return {
      draft: request.fallback,
      meta: {
        provider: 'deterministic',
        model: 'rules/v1',
        status: 'fallback',
        reason: 'deterministic provider selected',
        generatedAt: this.now.toISOString(),
      },
    };
  }
}

const MAX_AI_RESPONSE_BYTES = 256 * 1024;

interface ModelOpts {
  maxGenerations: number;
  timeoutMs: number;
  model: string;
  now: Date;
  fetchImpl: typeof fetch;
  apiKey?: string;
}

function mergeDraft(raw: string, fallback: WriteupDraft): WriteupDraft {
  try {
    const parsed = JSON.parse(raw) as Partial<WriteupDraft>;
    return {
      headline: parsed.headline ?? fallback.headline,
      dek: parsed.dek ?? fallback.dek,
      body: parsed.body ?? fallback.body,
      whyItMatters: parsed.whyItMatters ?? fallback.whyItMatters,
      readerAction: parsed.readerAction ?? fallback.readerAction,
    };
  } catch {
    return fallback;
  }
}

class OllamaProvider implements AiProvider {
  readonly name: ProviderName = 'ollama';
  private used = 0;
  private readonly opts: ModelOpts;
  private readonly baseUrl: string;
  constructor(opts: ModelOpts, baseUrl: string) {
    this.opts = opts;
    this.baseUrl = baseUrl;
  }
  canGenerate(): boolean {
    return this.used < this.opts.maxGenerations;
  }
  generationsUsed(): number {
    return this.used;
  }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const fallbackMeta: ProviderMeta = {
      provider: 'deterministic',
      model: 'rules/v1',
      status: 'fallback',
      generatedAt: this.opts.now.toISOString(),
    };
    if (!this.canGenerate()) {
      return { draft: request.fallback, meta: { ...fallbackMeta, reason: 'budget exhausted' } };
    }
    this.used++; // Always consume budget, including on failure — prevents infinite retry (#20).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.opts.apiKey) headers['Authorization'] = `Bearer ${this.opts.apiKey}`; // #18
      const res = await this.opts.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.opts.model,
          prompt: buildPrompt(request),
          format: 'json',
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return {
          draft: request.fallback,
          meta: { ...fallbackMeta, reason: `ollama HTTP ${res.status}` },
        };
      }
      const data = JSON.parse(await boundedText(res, MAX_AI_RESPONSE_BYTES)) as {
        response?: string;
      };
      return {
        draft: mergeDraft(data.response ?? '', request.fallback),
        meta: {
          provider: 'ollama',
          model: this.opts.model,
          status: 'generated',
          generatedAt: this.opts.now.toISOString(),
        },
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const reason =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'timeout'
            : err.message
          : 'unknown error';
      return { draft: request.fallback, meta: { ...fallbackMeta, reason } };
    }
  }
}

class OpenAiProvider implements AiProvider {
  readonly name: ProviderName = 'openai';
  private used = 0;
  private readonly opts: ModelOpts;
  private readonly apiKey: string;
  constructor(opts: ModelOpts, apiKey: string) {
    this.opts = opts;
    this.apiKey = apiKey;
  }
  canGenerate(): boolean {
    return this.used < this.opts.maxGenerations;
  }
  generationsUsed(): number {
    return this.used;
  }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const fallbackMeta: ProviderMeta = {
      provider: 'deterministic',
      model: 'rules/v1',
      status: 'fallback',
      generatedAt: this.opts.now.toISOString(),
    };
    if (!this.canGenerate()) {
      return { draft: request.fallback, meta: { ...fallbackMeta, reason: 'budget exhausted' } };
    }
    this.used++; // Always consume budget, including on failure — prevents infinite retry (#20).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.opts.fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: buildPrompt(request) }],
        }),
        signal: controller.signal,
        redirect: 'error', // #19: block open-redirect attacks with Bearer token in flight.
      });
      clearTimeout(timer);
      if (!res.ok) {
        return {
          draft: request.fallback,
          meta: { ...fallbackMeta, reason: `openai HTTP ${res.status}` },
        };
      }
      const data = JSON.parse(await boundedText(res, MAX_AI_RESPONSE_BYTES)) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      return {
        draft: mergeDraft(content, request.fallback),
        meta: {
          provider: 'openai',
          model: this.opts.model,
          status: 'generated',
          generatedAt: this.opts.now.toISOString(),
        },
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const reason =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'timeout'
            : err.message
          : 'unknown error';
      return { draft: request.fallback, meta: { ...fallbackMeta, reason } };
    }
  }
}

/** Resolve a provider from config + env. Defaults to deterministic. */
export function createProvider(config: ProviderConfig): AiProvider {
  const env = config.env ?? process.env;
  const enabled = config.enabled ?? !(env['ARDUR_AI_ENABLED'] === '0');
  const providerName: ProviderName =
    config.provider ?? (env['ARDUR_AI_PROVIDER'] as ProviderName | undefined) ?? 'deterministic';
  const maxGenerations = config.maxGenerations ?? envInt(env, 'ARDUR_AI_MAX_GENERATIONS', 20);
  const timeoutMs = config.timeoutMs ?? envInt(env, 'ARDUR_AI_TIMEOUT_MS', 20_000);
  const fetchImpl = config.fetchImpl ?? fetch;

  if (!enabled || providerName === 'deterministic') {
    return new DeterministicProvider(config.now);
  }
  const forceDeterministic = envFlag(env, 'ARDUR_AI_FORCE_DETERMINISTIC');
  if (forceDeterministic) return new DeterministicProvider(config.now);

  if (providerName === 'ollama') {
    const apiKey = env['OLLAMA_API_KEY'];
    const baseUrl = apiKey
      ? (env['OLLAMA_API_BASE'] ?? 'https://api.ollama.ai')
      : (env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434');
    return new OllamaProvider(
      {
        maxGenerations,
        timeoutMs,
        model: env['OLLAMA_MODEL'] ?? 'llama3.1',
        now: config.now,
        fetchImpl,
        ...(apiKey ? { apiKey } : {}), // #18: forward key so OllamaProvider sets Authorization header.
      },
      baseUrl,
    );
  }
  if (providerName === 'openai') {
    const apiKey = env['OPENAI_API_KEY'];
    if (!apiKey) return new DeterministicProvider(config.now);
    return new OpenAiProvider(
      {
        maxGenerations,
        timeoutMs,
        model: env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
        now: config.now,
        fetchImpl,
      },
      apiKey,
    );
  }
  return new DeterministicProvider(config.now);
}
