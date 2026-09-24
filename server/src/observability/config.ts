// Langfuse observability configuration, parsed from the LANGFUSE_* environment
// variables. Follows the same parse-function-per-var convention as lib/config.ts
// so an invalid value degrades to a safe default instead of throwing at boot.

import { readFileSync } from 'node:fs';

/** 0–1, the global trace-level sample fraction. Values outside the range fall
 *  back to 1.0 (sample everything) so a typo can never silently drop all
 *  telemetry AND so the default install observes everything. */
const DEFAULT_SAMPLE_RATE = 1.0;
/** Default maximum characters captured per observation input/output. Bounds the
 *  memory a long stream or huge body can hold in the bounded accumulator. */
const DEFAULT_MAX_CAPTURE_CHARS = 200_000;

/** The app release shown on the dashboard lives in desktop/package.json (the
 *  server package tracks the workspace, not the app — see Dockerfile #703).
 *  Read once at first use; a missing/unreadable file falls back to the env var
 *  then a constant, never to a throw. */
let cachedRelease: string | null = null;
function detectRelease(): string {
  if (cachedRelease !== null) return cachedRelease;
  if (process.env.LANGFUSE_RELEASE?.trim()) {
    cachedRelease = process.env.LANGFUSE_RELEASE.trim();
    return cachedRelease;
  }
  if (process.env.npm_package_version?.trim()) {
    cachedRelease = process.env.npm_package_version.trim();
    return cachedRelease;
  }
  try {
    const url = new URL('../../../desktop/package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      cachedRelease = pkg.version.trim();
      return cachedRelease;
    }
  } catch {
    // Not present in tests or in a sparse checkout — fall through.
  }
  cachedRelease = 'unknown';
  return cachedRelease;
}

export interface LangfuseObservabilityConfig {
  /** LANGFUSE_ENABLED — master switch. false (the default) → observability is
   *  fully inert: no SDK init, no spans, no effect on any request. */
  enabled: boolean;
  /** LANGFUSE_HOST — base URL of the Langfuse instance the OTLP exporter posts
   *  traces to, e.g. http://172.25.182.31:3000. The /api/public/otel path and
   *  the v4 ingestion version header are appended by otel.ts. */
  host: string;
  publicKey?: string;
  secretKey?: string;
  /** LANGFUSE_ENVIRONMENT — free-form environment tag (development, staging,
   *  production...). Defaults to NODE_ENV, then 'production'. */
  environment: string;
  /** Auto-detected from desktop/package.json (or LANGFUSE_RELEASE /
   *  npm_package_version), matching the release shown on the dashboard. */
  release: string;
  /** LANGFUSE_SAMPLE_RATE — global trace-level sample fraction (0–1). Decided
   *  once per request, so every fallback attempt of a request shares the
   *  decision. */
  sampleRate: number;
  /** LANGFUSE_CAPTURE_INPUT — whether model input (the provider-bound request
   *  body) is recorded on generations. Defaults to true. When false the input
   *  is omitted entirely; metadata is always kept. */
  captureInput: boolean;
  /** LANGFUSE_CAPTURE_OUTPUT — whether model output (the provider's response)
   *  is recorded on generations. Defaults to true. */
  captureOutput: boolean;
  /** Upper bound (characters) for a recorded input/output payload, applied by
   *  the observer so one giant stream or body cannot bloat an export batch. */
  maxCaptureChars: number;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'no') return false;
  return fallback;
}

function parseSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SAMPLE_RATE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_SAMPLE_RATE;
  return n;
}

export function loadObservabilityConfig(): LangfuseObservabilityConfig {
  return {
    enabled: parseBool(process.env.LANGFUSE_ENABLED, false),
    host: process.env.LANGFUSE_HOST?.trim() ?? '',
    publicKey: process.env.LANGFUSE_PUBLIC_KEY?.trim() || undefined,
    secretKey: process.env.LANGFUSE_SECRET_KEY?.trim() || undefined,
    environment: process.env.LANGFUSE_ENVIRONMENT?.trim() || process.env.NODE_ENV || 'production',
    release: detectRelease(),
    sampleRate: parseSampleRate(process.env.LANGFUSE_SAMPLE_RATE),
    captureInput: parseBool(process.env.LANGFUSE_CAPTURE_INPUT, true),
    captureOutput: parseBool(process.env.LANGFUSE_CAPTURE_OUTPUT, true),
    maxCaptureChars: DEFAULT_MAX_CAPTURE_CHARS,
  };
}

/** True only when every credential needed to reach Langfuse is present. The
 *  caller warns (and stays inert) when enabled-but-incomplete; it never throws,
 *  so a half-configured env cannot take the gateway down. */
export function hasCompleteLangfuseCredentials(cfg: LangfuseObservabilityConfig): boolean {
  if (!cfg.enabled) return false;
  if (!cfg.host) return false;
  // Keyless local installs exist (a trivially-proxied single-user Langfuse), but
  // the documented self-hosted setup always has a pk/sk pair. Both may be empty
  // together; a single missing one is incomplete.
  const hasPublic = Boolean(cfg.publicKey);
  const hasSecret = Boolean(cfg.secretKey);
  return hasPublic === hasSecret;
}

/** Expand a bare Langfuse host into the exact OTLP trace ingest URL Langfuse v4
 *  serves, deduplicating any path the operator already included. */
export function langfuseOtelEndpoint(host: string): string {
  const base = host.trim().replace(/\/+$/, '');
  const withPath = /\/api\/public\/otel\/?$/.test(base) ? base : `${base}/api/public/otel`;
  return `${withPath}/v1/traces`;
}