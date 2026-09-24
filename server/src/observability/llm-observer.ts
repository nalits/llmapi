// The generation observer: the small API the provider boundary calls to record
// one LLM inference attempt as a Langfuse v4 generation observation.
//
// Deliberately no Langfuse knowledge here beyond what attributes/ show: the
// provider (OpenAICompatProvider, later phase-14 custom providers) supplies what
// happened; this module records it as a generation span child of the active
// request span, and never throws — every path is fail-open. When
// observability is disabled, unsampled, or there is no active request context,
// observeGeneration returns an inert handle and the caller's logic is
// byte-for-byte unchanged.

import { context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { getRequestObservability } from './context.js';
import { getTracer } from './otel.js';
import {
  errorAttrs,
  finishAttrs,
  generationSpanName,
  startAttrs,
  type GenerationAttributes,
} from './attributes.js';
import { type LangfuseObservabilityConfig } from './config.js';

// The observer reads capture toggles from a lazily-resolved config so tests can
// flip them without re-seeding the module. Defaults: everything captured.
let currentConfig: LangfuseObservabilityConfig | null = null;
export function setObservabilityConfig(cfg: LangfuseObservabilityConfig | null): void {
  currentConfig = cfg;
}
export function getObservabilityConfig(): LangfuseObservabilityConfig | null {
  return currentConfig;
}

export interface GenerationHandle {
  /** Record first byte / first chunk latency (streaming). No-op if already set. */
  markFirstByte(ttfbMs?: number): void;
  /** Complete the generation successfully. */
  end(output: Partial<GenerationAttributes>): void;
  /** Record a failure for this attempt; the caller still throws afterwards. */
  error(error: unknown, statusCode?: number): void;
}

const NOOP_HANDLE: GenerationHandle = {
  markFirstByte: () => {},
  end: () => {},
  error: () => {},
};

/** Run attribute mutations guarded so no telemetry bug reaches the request. */
function withSpan(span: any, fn: () => void): void {
  try {
    fn();
  } catch {
    // swallow
  }
}

export interface ObserveGenerationInput {
  operation: 'chat' | 'stream';
  platform: string;
  model: string;
  requestedModel?: string;
  endpoint: string;
  attempt?: number;
  input?: unknown;
  samplingParameters?: Record<string, unknown>;
}

export function observeGeneration(input: ObserveGenerationInput): GenerationHandle {
  const request = getRequestObservability();
  const cfg = getObservabilityConfig();
  // Fail-open muzzle: not enabled, not sampled, or no active request — inert.
  if (cfg == null || !cfg.enabled || request == null || !request.ctx.sampled) return NOOP_HANDLE;

  const captureInput = cfg.captureInput;
  const captureOutput = cfg.captureOutput;
  const attempt = input.attempt ?? request.ctx.attempt;

  let attributes: GenerationAttributes;
  let span: any;
  try {
    const tracer = getTracer();
    attributes = {
      operation: input.operation,
      platform: input.platform,
      model: input.model,
      requestedModel: input.requestedModel ?? request.ctx.requestedModel,
      endpoint: input.endpoint,
      attempt,
      input: captureInput ? input.input : undefined,
      samplingParameters: input.samplingParameters,
      clientIp: request.ctx.clientIp,
      userAgent: request.ctx.userAgent,
      clientAgent: request.ctx.clientAgent,
      accountId: request.ctx.accountId,
      accountEmail: request.ctx.accountEmail,
      providerKeyLabel: request.ctx.providerKeyLabel,
      providerKeyId: request.ctx.providerKeyId,
    };
    span = tracer.startSpan(generationSpanName(input.platform, input.endpoint), {
      kind: SpanKind.CLIENT,
      attributes: startAttrs(attributes),
    }, context.active());
  } catch {
    // If span creation itself throws (a pathological SDK state), the request
    // must still succeed — return an inert handle.
    return NOOP_HANDLE;
  }

  const startedAt = Date.now();
  let ttfbMs: number | undefined;

  return {
    markFirstByte(ms?: number) {
      if (ttfbMs !== undefined) return;
      ttfbMs = ms ?? Date.now() - startedAt;
      withSpan(span, () => span.setAttribute('freellmapi.ttfb_ms', ttfbMs as number));
    },
    end(output: Partial<GenerationAttributes>) {
      const latencyMs = output.latencyMs ?? Date.now() - startedAt;
      withSpan(span, () => {
        span.setStatus({ code: SpanStatusCode.OK });
        const attrs = finishAttrs(
          {
            ...attributes,
            responseModel: output.responseModel,
            finishReasons: output.finishReasons,
            usage: output.usage,
            usageSource: output.usageSource,
            ttfbMs: output.ttfbMs ?? ttfbMs,
            latencyMs,
            output: captureOutput ? output.output : undefined,
          },
          captureInput,
          captureOutput,
        );
        for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
      });
      withSpan(span, () => span.end());
    },
    error(error: unknown, statusCode?: number) {
      withSpan(span, () => {
        span.setStatus({ code: SpanStatusCode.ERROR });
        for (const [k, v] of Object.entries(errorAttrs(error, statusCode))) span.setAttribute(k, v);
        span.recordException(error instanceof Error ? error : new Error(String(error ?? 'unknown error')));
      });
      withSpan(span, () => span.end());
    },
  } satisfies GenerationHandle;
}