# CHANGELOG — Langfuse observability via OpenTelemetry

Branch: `feature/langfuse-observability` · Base: `main` (`15c3008`)
Status: ready for review. Written for PR reviewers: **why** the change exists, **what** it does, and **impact** on the codebase.

## Why

FreeLLMAPI is a routing/fallback gateway: one user request fans out across many free upstream providers, and which provider actually answered is only visible as an "attempt" inside `runFallbackLoop()`'s failover ladder. Operators and dashboard users have no view of per-provider model latency, token usage, error rate, or first-byte latency — the exact data you need to judge whether a free tier is worth keeping in a chain.

Langfuse is the established open-source LLM observability backend. It accepts standard OpenTelemetry traces over OTLP/HTTP; a JVM-style vendor SDK is unnecessary. This branch ships the first observability layer at the gateway boundary: **one Langfuse `GENERATION` observation per real upstream provider attempt**, grouped under a per-request root trace.

The design is deliberately **opt-in and fail-open**. A missing or misconfigured Langfuse must never alter, delay, or break a single LLM request. Every instrumented path is wrapped so observability software faults are observability-only faults.

## What changed

### New module: `server/src/observability/`

| File | Purpose |
| --- | --- |
| `config.ts` | Env parsing (`LANGFUSE_*`), credential completeness check, `langfuseOtelEndpoint()` (accepts host with or without trailing slash / already-qualified `/api/public/otel` path), release auto-detect (`LANGFUSE_RELEASE` → `npm_package_version` → `desktop/package.json` → `unknown`). |
| `otel.ts` | SDK lifecycle: OTLP/HTTP protobuf exporter → `{host}/api/public/otel/v1/traces`, Basic auth `public:secret`, `x-langfuse-ingestion-version: 4` (Langfuse v4 real-time ingestion), `BatchSpanProcessor` (queue 2048, 1s scheduled flush), bounded `shutdownObservability(timeoutMs)` (5s) used by SIGTERM/SIGINT. |
| `context.ts` | `AsyncLocalStorage` request context (`surfaces`, `requestId`, `requestedModel`, `clientAgent`, `sampled`, `attempt`) + root `freellmapi.request` span with W3C `traceparent`/`tracestate` continuation of the caller's trace when present. |
| `sampling.ts` | Trace-level sampling, decided **once per request** (deterministic FNV-1a over `requestId`, random fallback). One verdict for the whole failover ladder — never tears a chain in half. |
| `attributes.ts` | Span attribute builders: `langfuse.observation.*`, `gen_ai.*`, `freellmapi.*`, `ml.usage.*`. Input/output capture gated by `LANGFUSE_CAPTURE_INPUT/OUTPUT`, payloads truncated at 200 000 chars with a `…[truncated by freellmapi]` marker. |
| `llm-observer.ts` | Per-attempt `GenerationHandle` (`markFirstByte`, `end`, `error` + `recordException` for stack traces). Fail-open: inert no-op observer when unconfigured/disabled/sampled-out/no active request. Single-terminal-call guard. Streaming output accumulated to a 50 000-char cap without ever touching bytes relayed to the client. |
| `index.ts` | Public API; binds `setObservabilityConfig(loadObservabilityConfig())` at import. |

### Instrumentation points (all behaviors fail-open)

- `server/src/index.ts` — `initObservability(loadObservabilityConfig())`; SIGTERM/SIGINT flush handlers registered **only** when the SDK actually started.
- `server/src/lib/fallback-loop.ts` — root trace begun in `runFallbackLoop`, finished in a `finally`. New optional `FallbackHooks.traceContextHeaders`. Per-dispatch 1-based `attempt` published into the request context so the provider's observer can attribute which hop of the ladder an observation belongs to.
- `server/src/providers/openai-compat.ts` — `chatCompletion()` (non-stream) and `streamChatCompletion()` (stream): create one generation observation per dispatch; on success attach captured output, usage (from provider-reported tokens or estimated fallback), response model, finish reasons; on failure mark ERROR (HTTP status) + recorded exception. Streaming marks first byte (TTFB) on the first content/usage chunk.

### Dependencies (new, all in `dependencies` so they survive `npm prune --omit=dev`)

`@opentelemetry/api ^1.9.1`, `@opentelemetry/sdk-node ^0.222.0`, `@opentelemetry/exporter-trace-otlp-http ^0.222.0`, `@opentelemetry/sdk-trace-base ^2.11.0`, `@opentelemetry/resources ^2.11.0`, `@opentelemetry/semantic-conventions ^1.43.0`. (`package-lock.json` updated.)

### Docs & tests

- `.env.example` — new "Observability: Langfuse via OpenTelemetry" section.
- `server/src/__tests__/observability/observability.test.ts` — 28 tests: config parsing, endpoint dedup, sampling determinism, attribute gating/truncation, observer fail-open, sampled request lifecycle, and `runFallbackLoop` wiring through `route()`.
- `tools/verify-installation/` — stdlib-only Python smoke client (uv project) that checks gateway, Langfuse reachability/credentials, and real chat / responses / messages / embeddings responses.

## Request flow (one request → Langfuse)

```
/v1/* request
  └─ runFallbackLoop()                      beginRequest → root span freellmapi.request
       └─ for each candidate route          ctx.attempt = n (published before dispatch)
            └─ OpenAICompatProvider
                 ├─ observeGeneration()     GENERATION span (parent = root)
                 ├─ … real upstream call …  markFirstByte() on first content
                 └─ end()/error()           output+usage+model or status+stack
  └─ finishRequest()                        root span ends, span closed, OTLP batch export
```

Trace-level sampling means a failover chain is sampled as a unit: attempt 1 and attempt 7 share the verdict, so Langfuse never shows a half-chain.

## Verification

All build/lint/test in a throwaway `node:20-bookworm-slim` Docker container (nothing installed on the host).

- `npm run build -w server` — clean.
- `npm run lint -w server` — clean.
- `npm run test -w server` — **3428 passed | 8 skipped** across 286 files (incl. the 28 new observability tests).
- Smoke client: 7/8. The one failure is pre-existing and unrelated — the check shelling out to `curl` inside the freellmapi image (no `curl` installed there).

### Live evidence (Langfuse v4, events-only deployment, `project-first`)

Instrumented the running deployment (image rebuilt from this branch) with `LANGFUSE_ENABLED=true`, host `:3000`, project keys. Startup log:

```
[observability] OpenTelemetry initialized → …/api/public/otel/v1/traces (env=development release=0.11.1 sampleRate=1)
```

Observations read back via `GET /api/public/v2/observations`:

- **3 successful traces** — chat/completions, /v1/responses, /v1/messages — each a root `freellmapi.request` span + one `GENERATION` per attempt (`openrouter.chat.completions`, `kilo.chat.completions`). Request/response bodies captured verbatim, `usageDetails {input: 23, output: 16, total: 39}`, latency, `release=0.11.1` (auto-detect works in the image).
- **Error path** — a 10-attempt failover storm (rate limits + HTTP errors): generations correctly marked `ERROR` for transport failures (`ovh` 429, `kilo` 429) with recorded exception; root span covers the whole ladder.

## Provider coverage

Instrumented boundary is `OpenAICompatProvider` (the fallback router's most-used provider class). **YES = live-verified in this branch.**

| Platform | Chat | Responses | Messages | Verified |
| --- | --- | --- | --- | --- |
| openrouter | generation per attempt | via router | via router | YES (success + error) |
| kilo | generation per attempt | via router | via router | YES (success + error) |
| aion / ovh | generation per attempt | via router | via router | YES (error path) |
| google / cloudflare / aihorde (native providers) | — | — | — | NOT instrumented (separate provider classes) |
| custom providers | — | — | — | NOT instrumented |

## Known limitations & impact

1. **Native and custom providers are not yet observed.** Only `OpenAICompatProvider` produces generation observations. The root `freellmapi.request` trace still covers the full attempt ladder for every provider; only per-attempt business data (usage/latency) is missing for non-compat providers. Covered by the fail-open design (their attempts still work); a later phase instruments the remaining provider classes.
2. **"Empty completion" attempts are recorded as successful (DEFAULT).** The empty-completion verdict is decided by the route *after* the provider's 200 response has been fully consumed, when the provider already closed its OTel span — OTel spans cannot be reopened, so the generation shows the transport-level truth (HTTP 200, no output) as DEFAULT. Provider-level errors (HTTP 4xx/5xx, disconnects) are correctly ERROR.
3. **Embeddings are not observed.** They do not pass through `runFallbackLoop`.
4. **No user identity is captured.** `userId` is intentionally left empty; identity propagation was explicitly out of scope for this phase.
5. **Langfuse v4 vs v3.** The `x-langfuse-ingestion-version: 4` header targets the v4 data model (verified against a v4 `events_only` deployment). On Langfuse v3 the same endpoint accepts the batch (header ignored) with up-to-15-minute ingestion delay — no code change needed.
6. **Sampling default is 1.0.** Set `LANGFUSE_SAMPLE_RATE` < 1 to cap outbound observation volume on high-traffic installs.

### Ops / rollback

- Opt-in: an unset or half-set `LANGFUSE_*` block leaves the pipeline untouched (one warning log). To disable entirely, unset `LANGFUSE_ENABLED` or the credentials.
- The container rebuilt for verification runs this branch's image; rebuild from `ghcr` to return to published releases.