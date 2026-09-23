// Request-scoped observability context: the single per-request state
// observability reads once the fallback loop (or a surface) has begun a trace.
// Travels on AsyncLocalStorage like client-context.ts / attempt-trace.ts, so the
// provider boundary (deep inside an awaited dispatch) can pick up attempt,
// requestId and requestedModel without any parameter threading.
//
// The root span (`freellmapi.request`) is created here and made the ACTIVE span
// for the request, so every generation observation started later — child of the
// active context — parents under it automatically.

import { AsyncLocalStorage } from 'node:async_hooks';
import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace, type Context, type Span } from '@opentelemetry/api';
import { getTracer } from './otel.js';
import { shouldSample } from './sampling.js';

export interface RequestObservabilityContext {
  /** Which gateway surface served the request ('chat completions', 'responses',
   *  'anthropic messages', 'inbound chat', ...). */
  surface: string;
  /** X-Request-ID (or a generated uuid) — the same id stamped on responses. */
  requestId: string;
  /** The model the client asked for ('auto', a family id, a specific id). */
  requestedModel?: string;
  /** Classified client agent (from client-classifier.ts); never the raw UA. */
  clientAgent: string | null;
  /** Trace-level sampling verdict shared by every span of this request. */
  sampled: boolean;
  /** 1-based fallback attempt index, set by the loop right before each dispatch. */
  attempt: number;
  /** Baseline for latency accounting; the loop's clock, not wall time. */
  startedAt: number;
}

/** Opaque handle returned by beginRequest; the loop calls runWithRequestObservability
 *  and finishRequest inside its finally. */
export interface RequestObservability {
  readonly ctx: RequestObservabilityContext;
  readonly span: Span;
  readonly activeContext: Context;
}

const storage = new AsyncLocalStorage<RequestObservability>();

export interface BeginRequestOptions {
  surface: string;
  requestId: string;
  requestedModel?: string;
  clientAgent?: string | null;
  sampleRate: number;
  /** Inbound request headers (Express req.headers — lowercase keys). When the
   *  caller carries a W3C traceparent/tracestate the request span continues that
   *  trace; otherwise a fresh trace is rooted here. */
  inboundHeaders?: Record<string, unknown> | Record<string, string | string[] | undefined>;
  startedAt?: number;
}

/** Begin the request trace. Returns undefined when sampling decided against this
 *  request (or some piece of required metadata is missing), in which case the
 *  caller runs without any observability — generation observers will no-op. */
export function beginRequest(opts: BeginRequestOptions): RequestObservability | undefined {
  const sampled = shouldSample(opts.sampleRate, opts.requestId);
  const tracer = getTracer();
  const parentCtx = opts.inboundHeaders ? propagation.extract(ROOT_CONTEXT, opts.inboundHeaders) : ROOT_CONTEXT;

  if (sampled) {
    const span = tracer.startSpan('freellmapi.request', {
      attributes: buildRequestAttributes(opts.surface, opts.requestId, opts.requestedModel, opts.clientAgent),
    }, parentCtx);
    const activeContext = trace.setSpan(parentCtx, span);
    return {
      ctx: {
        surface: opts.surface,
        requestId: opts.requestId,
        requestedModel: opts.requestedModel,
        clientAgent: opts.clientAgent ?? null,
        sampled,
        attempt: 0,
        startedAt: opts.startedAt ?? Date.now(),
      },
      span,
      activeContext,
    };
  }

  // Unsampled: still track the request so generation observers can no-op cheaply
  // and the attempt counter stays meaningful. No span exists to keep active.
  return {
    ctx: {
      surface: opts.surface,
      requestId: opts.requestId,
      requestedModel: opts.requestedModel,
      clientAgent: opts.clientAgent ?? null,
      sampled,
      attempt: 0,
      startedAt: opts.startedAt ?? Date.now(),
    },
    span: undefined as unknown as Span,
    activeContext: parentCtx,
  };
}

/** Run `fn` with the request observability in scope (ALS + OTEL active span). */
export function withRequestObservability<T>(handle: RequestObservability, fn: () => T): T {
  return storage.run(handle, () => context.with(handle.activeContext, fn));
}

/** The current request's observability, or undefined outside a traced request. */
export function getRequestObservability(): RequestObservability | undefined {
  return storage.getStore();
}

export interface FinishRequestOptions {
  error?: unknown;
  statusCode?: number;
}

/** End the request span. Sets ERROR status + exception when something failed;
 *  otherwise leaves the (default UNSET) status — the observation is complete.
 *  No-op for handles with no span (unsampled). */
export function finishRequest(handle: RequestObservability, opts: FinishRequestOptions = {}): void {
  if (handle.sampled === false) return;
  if (opts.error != null) {
    handle.span.setStatus({ code: SpanStatusCode.ERROR });
    if (opts.statusCode != null) handle.span.setAttribute('http.response.status_code', opts.statusCode);
    handle.span.recordException(opts.error instanceof Error ? opts.error : new Error(String(opts.error)));
  }
  handle.span.end();
}

function buildRequestAttributes(
  surface: string,
  requestId: string,
  requestedModel?: string,
  clientAgent?: string | null,
): Record<string, string> {
  const attrs: Record<string, string> = {
    'freellmapi.surface': surface,
    'freellmapi.request_id': requestId,
  };
  if (requestedModel) attrs['freellmapi.requested_model'] = requestedModel;
  if (clientAgent) attrs['freellmapi.client_agent'] = clientAgent;
  return attrs;
}