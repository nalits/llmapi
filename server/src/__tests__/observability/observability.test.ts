import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseProvider } from '../../providers/base.js';
import { runFallbackLoop, newFallbackState, type FallbackHooks, type DispatchOutcome } from '../../lib/fallback-loop.js';
import {
  beginRequest,
  finishRequest,
  getRequestObservability,
  setObservabilityConfig,
  withRequestObservability,
  shouldSample,
  observeGeneration,
  generationSpanName,
  type GenerationAttributes,
  type RequestObservability,
  type LangfuseObservabilityConfig,
} from '../../observability/index.js';
import { langfuseOtelEndpoint, hasCompleteLangfuseCredentials, loadObservabilityConfig } from '../../observability/config.js';
import { startAttrs, finishAttrs, errorAttrs } from '../../observability/attributes.js';

// The observability tests run against the no-op OTEL tracer (no SDK started):
// every span is non-recording, which is exactly the fail-open posture the
// gateway ships with by default. We assert CONTROLLED behavior here — config
// parsing, sampling determinism, attribute construction, gating, and the
// fallback-loop wiring — not exporter output.

const enabledConfig = (overrides: Partial<LangfuseObservabilityConfig> = {}): LangfuseObservabilityConfig => ({
  enabled: true,
  host: 'http://langfuse.test',
  publicKey: 'pk-test',
  secretKey: 'sk-test',
  environment: 'test',
  release: 'test-release',
  sampleRate: 1,
  captureInput: true,
  captureOutput: true,
  maxCaptureChars: 200_000,
  ...overrides,
});

// RouteResult needs a BaseProvider; a bare cast is enough for the loop paths
// covered here (dispatch returns immediately, no provider method is called).
const fakeRoute = () => ({
  provider: {} as unknown as BaseProvider,
  modelId: 'testmodel',
  modelDbId: 1,
  apiKey: 'k',
  keyId: 1,
  keyLabel: null,
  platform: 'testplatform',
  displayName: 'Test Model',
  endpointScope: '',
  rpdLimit: null,
  tpdLimit: null,
});

const noopHooks = (): Partial<FallbackHooks> => ({
  logFailure() {},
  onFatal() {},
  onRoutingExhausted() {},
  onExhausted() {},
});

afterEach(() => {
  setObservabilityConfig(null);
  delete process.env.LANGFUSE_ENABLED;
  delete process.env.LANGFUSE_HOST;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_SAMPLE_RATE;
  delete process.env.LANGFUSE_CAPTURE_INPUT;
  delete process.env.LANGFUSE_CAPTURE_OUTPUT;
  delete process.env.LANGFUSE_ENVIRONMENT;
  delete process.env.LANGFUSE_RELEASE;
});

// ── sampling ─────────────────────────────────────────────────────────────────

describe('shouldSample', () => {
  it('samples everything at rate 1 even with a request id', () => {
    expect(shouldSample(1, 'req-1')).toBe(true);
    expect(shouldSample(1, 'req-2')).toBe(true);
  });

  it('samples nothing at rate 0', () => {
    expect(shouldSample(0, 'req-1')).toBe(false);
  });

  it('is deterministic for a fixed request id', () => {
    // Same id ⇒ same verdict every time (this is what makes per-trace sampling
    // testable and stable across a failover ladder).
    expect(shouldSample(0.5, 'deterministic-id')).toBe(shouldSample(0.5, 'deterministic-id'));
  });

  it('rejects non-finite rates by sampling everything', () => {
    expect(shouldSample(Number.NaN, 'req')).toBe(true);
    expect(shouldSample(Number.POSITIVE_INFINITY, 'req')).toBe(true);
  });

  it('falls back to a random roll when there is no request id', () => {
    expect(typeof shouldSample(0.5)).toBe('boolean');
  });
});

// ── attributes ────────────────────────────────────────────────────────────────

describe('generationSpanName', () => {
  it('normalizes an endpoint path into the span name', () => {
    expect(generationSpanName('openrouter', 'chat/completions')).toBe('openrouter.chat.completions');
  });

  it('handles leading slashes and version prefixes', () => {
    expect(generationSpanName('custom', '/v1/chat/completions')).toBe('custom.v1.chat.completions');
  });
});

describe('startAttrs', () => {
  it('marks the observation as a Langfuse generation with model metadata', () => {
    const attrs = startAttrs({ operation: 'chat', platform: 'groq', model: 'llama-3.3-70b', endpoint: 'chat/completions', attempt: 2 });
    expect(attrs['langfuse.observation.type']).toBe('generation');
    expect(attrs['langfuse.observation.model.name']).toBe('llama-3.3-70b');
    expect(attrs['gen_ai.system']).toBe('groq');
    expect(attrs['freellmapi.attempt']).toBe(2);
    expect(attrs['freellmapi.endpoint']).toBe('chat/completions');
  });
});

describe('finishAttrs gating', () => {
  it('records input/output only when capture is enabled, always records usage', () => {
    const gen: GenerationAttributes = {
      operation: 'chat',
      platform: 'groq',
      model: 'llama-3.3-70b',
      endpoint: 'chat/completions',
      input: { messages: [{ role: 'user', content: 'hi' }] },
      output: { choices: [{ text: 'hello' }] },
      usage: { input: 10, output: 5, total: 15 },
      usageSource: 'provider',
      finishReasons: ['stop'],
      latencyMs: 42,
    };

    const on = finishAttrs(gen, true, true);
    expect(String(on['langfuse.observation.input'])).toContain('"hi"');
    expect(String(on['langfuse.observation.output'])).toContain('hello');
    expect(String(on['langfuse.observation.usage_details'])).toContain('"input":10');
    expect(on['gen_ai.usage.input_tokens']).toBe(10);
    expect(on['gen_ai.usage.output_tokens']).toBe(5);
    expect(on['freellmapi.latency_ms']).toBe(42);

    const off = finishAttrs(gen, false, false);
    expect(off['langfuse.observation.input']).toBeUndefined();
    expect(off['langfuse.observation.output']).toBeUndefined();
    // Metadata is never payload-gated: usage and finish reasons still ride.
    expect(off['langfuse.observation.usage_details']).toBeDefined();
    expect(off['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('truncates a payload over the capture cap with a marker', () => {
    const big = 'x'.repeat(300_000);
    const attrs = finishAttrs({ operation: 'chat', platform: 'p', model: 'm', endpoint: 'e', output: big } as GenerationAttributes, true, true);
    const value = String(attrs['langfuse.observation.output']);
    expect(value.endsWith('…[truncated by freellmapi]')).toBe(true);
    // Cap + newline + marker overhead, well under the original.
    expect(value.length).toBeLessThan(big.length);
    expect(value.length).toBeLessThan(200_100);
  });

  it('builds error attributes from a message and status', () => {
    const attrs = errorAttrs(new Error('upstream 502'), 502);
    expect(attrs['freellmapi.error.message']).toBe('upstream 502');
    expect(attrs['http.response.status_code']).toBe(502);
  });
});

// ── config ────────────────────────────────────────────────────────────────────

describe('loadObservabilityConfig', () => {
  it('defaults to fully disabled with no LANGFUSE_* variables', () => {
    const cfg = loadObservabilityConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.sampleRate).toBe(1);
    expect(cfg.captureInput).toBe(true);
    expect(cfg.captureOutput).toBe(true);
  });

  it('parses enabled + credentials and validates completeness', () => {
    process.env.LANGFUSE_ENABLED = 'true';
    process.env.LANGFUSE_HOST = 'http://langfuse.test';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-x';
    process.env.LANGFUSE_SECRET_KEY = 'sk-x';
    const cfg = loadObservabilityConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.host).toBe('http://langfuse.test');
    expect(hasCompleteLangfuseCredentials(cfg)).toBe(true);
  });

  it('treats a half-configured credential pair as incomplete', () => {
    process.env.LANGFUSE_ENABLED = 'true';
    process.env.LANGFUSE_HOST = 'http://langfuse.test';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-x';
    delete process.env.LANGFUSE_SECRET_KEY;
    expect(hasCompleteLangfuseCredentials(loadObservabilityConfig())).toBe(false);
  });

  it('falls back to sampleRate 1.0 for out-of-range or garbage values', () => {
    process.env.LANGFUSE_SAMPLE_RATE = '2';
    expect(loadObservabilityConfig().sampleRate).toBe(1);
    process.env.LANGFUSE_SAMPLE_RATE = 'nope';
    expect(loadObservabilityConfig().sampleRate).toBe(1);
    process.env.LANGFUSE_SAMPLE_RATE = '0.4';
    expect(loadObservabilityConfig().sampleRate).toBeCloseTo(0.4);
  });

  it('parses capture toggles and the environment tag', () => {
    process.env.LANGFUSE_ENABLED = '1';
    process.env.LANGFUSE_CAPTURE_INPUT = 'false';
    process.env.LANGFUSE_CAPTURE_OUTPUT = '0';
    process.env.LANGFUSE_ENVIRONMENT = 'staging';
    const cfg = loadObservabilityConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.captureInput).toBe(false);
    expect(cfg.captureOutput).toBe(false);
    expect(cfg.environment).toBe('staging');
  });

  it('detects a non-empty release from the desktop package.json when unset', async () => {
    // Cold-module load so the config cache has not been primed by observability/
    // index.ts (which runs loadObservabilityConfig() at import time).
    vi.resetModules();
    delete process.env.LANGFUSE_RELEASE;
    const mod = await import('../../observability/index.js');
    const cfg = mod.loadObservabilityConfig();
    expect(typeof cfg.release).toBe('string');
    expect(cfg.release.length).toBeGreaterThan(0);
  });

  it('lets LANGFUSE_RELEASE win when the module loads cold', async () => {
    vi.resetModules();
    process.env.LANGFUSE_RELEASE = '9.9.9';
    const mod = await import('../../observability/index.js');
    expect(mod.loadObservabilityConfig().release).toBe('9.9.9');
  });
});

describe('langfuseOtelEndpoint', () => {
  it('appends the v4 OTLP ingest path to a bare host', () => {
    expect(langfuseOtelEndpoint('http://langfuse.test')).toBe('http://langfuse.test/api/public/otel/v1/traces');
  });

  it('deduplicates an already-qualified host', () => {
    expect(langfuseOtelEndpoint('http://langfuse.test/api/public/otel')).toBe('http://langfuse.test/api/public/otel/v1/traces');
    expect(langfuseOtelEndpoint('http://langfuse.test/api/public/otel/')).toBe('http://langfuse.test/api/public/otel/v1/traces');
  });

  it('strips trailing slashes before appending', () => {
    expect(langfuseOtelEndpoint('http://langfuse.test/')).toBe('http://langfuse.test/api/public/otel/v1/traces');
  });
});

// ── request context + observer fail-open ──────────────────────────────────────

describe('beginRequest / observeGeneration fail-open', () => {
  it('returns an inert generation handle when observability is unconfigured', () => {
    setObservabilityConfig(null);
    const handle = observeGeneration({ operation: 'chat', platform: 'p', model: 'm', endpoint: 'e' });
    expect(() => { handle.markFirstByte(); handle.end({ output: 'x' }); handle.error(new Error('boom')); }).not.toThrow();
  });

  it('returns an inert handle when disabled', () => {
    setObservabilityConfig(enabledConfig({ enabled: false }));
    const handle = observeGeneration({ operation: 'chat', platform: 'p', model: 'm', endpoint: 'e' });
    expect(() => { handle.end({ output: 'x' }); }).not.toThrow();
  });

  it('returns an inert handle when the request was sampled out', () => {
    setObservabilityConfig(enabledConfig());
    const obs = beginRequest({ surface: 'chat', requestId: 'req-1', sampleRate: 0 });
    expect(obs?.ctx.sampled).toBe(false);
    if (!obs) throw new Error('expected handle');
    withRequestObservability(obs, () => {
      const handle = observeGeneration({ operation: 'chat', platform: 'p', model: 'm', endpoint: 'e' });
      expect(() => { handle.end({ output: 'x' }); handle.error(new Error('boom')); }).not.toThrow();
    });
  });

  it('returns an inert handle with no active request context', () => {
    setObservabilityConfig(enabledConfig());
    const handle = observeGeneration({ operation: 'chat', platform: 'p', model: 'm', endpoint: 'e' });
    expect(() => { handle.end({ output: 'x' }); }).not.toThrow();
  });

  it('supports a full sampled lifecycle without a running SDK (no-op tracer)', () => {
    setObservabilityConfig(enabledConfig());
    const obs = beginRequest({
      surface: 'responses',
      requestId: 'req-lifecycle',
      requestedModel: 'test-model',
      clientAgent: 'curl',
      sampleRate: 1,
    });
    if (!obs) throw new Error('expected a sampled handle');
    withRequestObservability(obs, () => {
      const handle = observeGeneration({ operation: 'chat', platform: 'openrouter', model: 'x/y', endpoint: 'chat/completions' });
      expect(getRequestObservability()?.ctx.requestId).toBe('req-lifecycle');
      handle.markFirstByte();
      handle.end({ output: { choices: [] }, usage: { input: 1, output: 2, total: 3 }, finishReasons: ['stop'] });
      finishRequest(obs);
    });
  });
});

// ── fallback-loop wiring ──────────────────────────────────────────────────────

describe('runFallbackLoop observability wiring', () => {
  it('establishes the request trace before routing and closes it afterwards', async () => {
    setObservabilityConfig(enabledConfig());
    let observedDuringRoute: RequestObservability | undefined;
    let exhausted = false;
    await runFallbackLoop({
      maxRetries: 1,
      timeBudgetMs: 20_000,
      state: newFallbackState(),
      logIdentity: { surface: 'chat completions', requestId: 'loop-route-req', requestedModel: 'test-model' },
      traceContextHeaders: { 'user-agent': 'test' },
      route() {
        observedDuringRoute = getRequestObservability();
        throw new Error('no candidates');
      },
      dispatch: async () => 'done' as DispatchOutcome,
      ...noopHooks(),
      onRoutingExhausted() { exhausted = true; },
    } as FallbackHooks);
    expect(observedDuringRoute?.ctx.surface).toBe('chat completions');
    expect(observedDuringRoute?.ctx.requestId).toBe('loop-route-req');
    expect(observedDuringRoute?.ctx.requestedModel).toBe('test-model');
    expect(exhausted).toBe(true);
  });

  it('publishes the attempt ordinal before each dispatch', async () => {
    setObservabilityConfig(enabledConfig());
    let attemptSeen: number | undefined;
    await runFallbackLoop({
      maxRetries: 1,
      timeBudgetMs: 20_000,
      state: newFallbackState(),
      logIdentity: { surface: 'chat completions', requestId: 'loop-attempt-req' },
      route: fakeRoute,
      async dispatch() {
        attemptSeen = getRequestObservability()?.ctx.attempt;
        return 'done' as DispatchOutcome;
      },
      ...noopHooks(),
    } as FallbackHooks);
    // Loop attempt is 0-based; the published ordinal is 1-based.
    expect(attemptSeen).toBe(1);
  });
});