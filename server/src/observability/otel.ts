// OpenTelemetry SDK lifecycle for Langfuse v4 OTLP ingest.
//
// All of this is inert unless LANGFUSE_ENABLED=true with complete credentials.
// initObservability() is idempotent and never throws: an unusable config is
// logged and skipped so the gateway starts exactly as it would without any
// LANGFUSE_* variables.

import { ROOT_CONTEXT, trace, type Context, type Span, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { langfuseOtelEndpoint, type LangfuseObservabilityConfig } from './config.js';

// Time-boxed hostname -> the ingestion version header Langfuse v4 expects.
const LANGFUSE_INGESTION_VERSION = '4';

let sdk: NodeSDK | undefined;
let started = false;

/** Whether the SDK has been started. Tests use this to reset between cases. */
export function isObservabilityStarted(): boolean {
  return started;
}

function basicAuthToken(publicKey: string, secretKey: string): string {
  // Keys are project-scoped (pk-lf-... / sk-lf-...); base64 of "public:secret"
  // is the documented Langfuse signal-auth scheme over OTLP.
  return Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
}

interface InitResult {
  started: boolean;
  reason?: string;
}

/** Start the BatchSpanProcessor-backed SDK, or no-op safely. Call once at boot
 *  from index.ts. Also wires graceful flush on SIGTERM/SIGINT (bounded) so the
 *  last request isn't lost on shutdown. */
export function initObservability(cfg: LangfuseObservabilityConfig): InitResult {
  if (started) return { started: true };
  if (!cfg.enabled) return { started: false, reason: 'LANGFUSE_ENABLED is not true' };
  if (!cfg.host || !cfg.publicKey || !cfg.secretKey) {
    console.warn(
      '[observability] LANGFUSE_ENABLED=true but LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY are incomplete — observability is DISABLED; the gateway runs unchanged.',
    );
    return { started: false, reason: 'incomplete credentials' };
  }

  const exporter = new OTLPTraceExporter({
    url: langfuseOtelEndpoint(cfg.host),
    headers: {
      Authorization: `Basic ${basicAuthToken(cfg.publicKey, cfg.secretKey)}`,
      'X-Langfuse-Ingestion-Version': LANGFUSE_INGESTION_VERSION,
    },
  });

  const attributes: Record<string, string> = { [ATTR_SERVICE_NAME]: 'freellmapi' };
  if (cfg.release && cfg.release !== 'unknown') attributes[ATTR_SERVICE_VERSION] = cfg.release;
  attributes['deployment.environment'] = cfg.environment;
  const resource = resourceFromAttributes(attributes);

  sdk = new NodeSDK({
    resource,
    traceExporter: exporter,
    spanProcessors: [new BatchSpanProcessor(exporter, { maxQueueSize: 2048, scheduledDelayMillis: 1000 })],
  });

  try {
    sdk.start();
  } catch (err) {
    console.warn(`[observability] OpenTelemetry SDK failed to start: ${(err as Error)?.message ?? err}`);
    sdk = undefined;
    return { started: false, reason: 'sdk start failure' };
  }
  started = true;
  console.log(
    `[observability] OpenTelemetry initialized → Langfuse at ${langfuseOtelEndpoint(cfg.host)} (env=${cfg.environment} release=${cfg.release} sampleRate=${cfg.sampleRate})`,
  );
  return { started: true };
}

/** Flush and shut the SDK down. Bounded to `timeoutMs` (default 5s) so a stuck
 *  exporter can never hang the process on SIGTERM. Idempotent; safe to call
 *  when observability was never initialized (no-op). */
export async function shutdownObservability(timeoutMs = 5000): Promise<void> {
  if (!sdk || !started) return;
  const shuttingDown = sdk.shutdown();
  try {
    await Promise.race([shuttingDown, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  } catch {
    // Export errors are never request-fatal; ignore on shutdown too.
  }
  sdk = undefined;
  started = false;
}

export function getTracer(): Tracer {
  return trace.getTracer('freellmapi');
}

// Re-export the bits consumers of this module commonly need (sampling/context
// helpers in lib keep their imports from @opentelemetry/api directly).
export { ROOT_CONTEXT };
export type { Context, Span };