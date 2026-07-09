/**
 * Hermes LLM client for radar writeups.
 *
 * Proxy-first when GATEWAY_PROXY_URL / HERMES_PROXY_URL is set, else CLI
 * `hermes chat -q` when available. CI / HERMES_AVAILABLE=0 skips to null.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function forceSkip(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['HERMES_AVAILABLE'] === '0' || env['CI'] === 'true';
}

let _checked = false;
let _available = false;

export function hermesAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (forceSkip(env)) return false;
  // Proxy path does not require CLI hermes binary.
  if ((env['GATEWAY_PROXY_URL'] || env['HERMES_PROXY_URL'] || '').trim()) return true;
  if (_checked) return _available;
  _checked = true;
  try {
    execSync('which hermes', { timeout: 3000, stdio: 'ignore' });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

export function hermesProxyBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env['GATEWAY_PROXY_URL'] || env['HERMES_PROXY_URL'] || '').trim();
  if (!raw) return null;
  return raw.replace(/\/$/, '');
}

export function hermesProxyKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = (env['GATEWAY_PROXY_KEY'] || env['HERMES_PROXY_KEY'] || '').trim();
  return key || undefined;
}

/** CLI path — returns raw stdout or null. */
export function hermesGenerateCli(
  prompt: string,
  opts: { timeoutMs?: number; model?: string; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = opts.env ?? process.env;
  if (forceSkip(env)) return null;
  // Only use CLI when no proxy configured and binary is available.
  if (hermesProxyBase(env)) return null;
  if (!hermesAvailable(env)) return null;

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const modelArg = opts.model ? `-m "${opts.model}"` : '';
  const tmpFile = join(tmpdir(), `hermes-radar-prompt-${randomUUID()}.txt`);
  try {
    writeFileSync(tmpFile, prompt, 'utf8');
    const result = execSync(`hermes chat -q "$(cat '${tmpFile}')" ${modelArg} --quiet`, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 100 * 1024,
      shell: '/bin/bash',
      env: process.env,
    });
    return result.trim() || null;
  } catch {
    return null;
  } finally {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

export async function hermesGenerateProxy(
  prompt: string,
  opts: {
    timeoutMs?: number;
    model?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const base = hermesProxyBase(env);
  if (!base) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = hermesProxyKey(env);
    if (key) headers['Authorization'] = `Bearer ${key}`;
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: opts.model || env['HERMES_MODEL'] || 'hermes-agent',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
