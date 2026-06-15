/**
 * Agent-readiness descriptor. `--describe` emits this JSON so the Hermes agent
 * layer (and ardur-pipeline) can introspect the engine — its inputs, outputs,
 * env knobs, and idempotency — without running it. Mirrors the tool-manifest
 * shape the news engines expose via ardur-pipeline/docs/tool-manifests/*.json.
 */

import { CONTRACT_REVISION, RADAR_SCHEMA_VERSION } from './contracts.ts';

export interface ToolManifest {
  name: string;
  description: string;
  manifestVersion: string;
  contractRevision: number;
  radarSchemaVersion: string;
  cli: {
    flags: Array<{ flag: string; arg: string | null; description: string }>;
    env: string[];
    stdout: 'json';
    errors: 'json-on-stderr';
  };
  inputArtifact: 'radar' | null;
  outputArtifact: 'radar';
  idempotency: 'cycle';
  stateless: boolean;
}

export function describe(): ToolManifest {
  return {
    name: 'radar-engine',
    description:
      'Standalone OSS RADAR engine: GitHub + chatter ingestion, momentum signals, Top-10 OSS ranking, persisted ledger, signal map, and fact-grounded AI-primary project writeups. Holds the whole Radar pipeline in one process.',
    manifestVersion: '1.0.0',
    contractRevision: CONTRACT_REVISION,
    radarSchemaVersion: RADAR_SCHEMA_VERSION,
    cli: {
      flags: [
        {
          flag: '--in',
          arg: 'path',
          description: 'previous RadarArtifact JSON (ledger history / dropout continuity)',
        },
        {
          flag: '--out',
          arg: 'path',
          description: 'write the RadarArtifact here (default: stdout)',
        },
        { flag: '--now', arg: 'iso', description: 'pin the engine clock for deterministic replay' },
        { flag: '--describe', arg: null, description: 'print this tool manifest and exit' },
      ],
      env: [
        'ARDUR_AI_PROVIDER',
        'ARDUR_AI_ENABLED',
        'ARDUR_AI_FORCE_DETERMINISTIC',
        'ARDUR_AI_MAX_GENERATIONS',
        'ARDUR_AI_TIMEOUT_MS',
        'OLLAMA_HOST',
        'OLLAMA_MODEL',
        'OLLAMA_API_KEY',
        'OLLAMA_API_BASE',
        'OPENAI_API_KEY',
        'OPENAI_MODEL',
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'ARDUR_OSS_FETCH_GITHUB',
        'ARDUR_GITHUB_SEARCH_DELAY_MS',
        'ARDUR_OSS_FETCH_HN',
        'ARDUR_OSS_FETCH_REDDIT',
        'ARDUR_OSS_FETCH_DEVTO',
        'ARDUR_OSS_FETCH_MEDIUM',
        'ARDUR_OSS_FETCH_YOUTUBE',
        'ARDUR_OSS_FETCH_X',
        'YOUTUBE_API_KEY',
        // X_API_BEARER_TOKEN intentionally omitted — X/Twitter is stubbed as unavailable.
      ],
      stdout: 'json',
      errors: 'json-on-stderr',
    },
    inputArtifact: 'radar',
    outputArtifact: 'radar',
    idempotency: 'cycle',
    stateless: false, // #22: engine reads/writes persisted ledger via --in/--out.
  };
}
