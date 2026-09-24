// Attribute construction for generation observations — the single place that
// knows the Langfuse v4 + GenAI semantic-convention attribute vocabulary, so
// provider code never scatters raw attribute strings.
//
// Langfuse v4 (OTLP ingest) maps generation observations from these keys:
//   langfuse.observation.type           → 'generation'
//   langfuse.observation.input          → the model input payload
//   langfuse.observation.output         → the model output payload
//   langfuse.observation.model.name     → served model id
//   langfuse.observation.model.parameters → sampling/model parameters
//   langfuse.observation.usage_details  → { input, output, total } tokens
//   langfuse.user.id                    → llmapi account (email, else user:<id>)
//   langfuse.trace.metadata.*           → caller IP / account / UA on the trace
//   langfuse.observation.metadata.*     → same plus the provider key on each hop
// GenAI semantic-convention attrs give the same data its portable spelling.

export type UsageSource = 'provider' | 'estimated';

export interface CallerMetadata {
  /** Socket / trust-proxy client IP. Null when REQUEST_ANALYTICS_LOG_CLIENT=false. */
  clientIp?: string | null;
  userAgent?: string | null;
  clientAgent?: string | null;
  /** Dashboard / API account id (multi-user). */
  accountId?: number;
  /** users.email for that account, when readable. */
  accountEmail?: string;
  /** Operator-assigned api_keys.label for the key this hop used. */
  providerKeyLabel?: string | null;
  providerKeyId?: number;
}

export interface GenerationAttributes extends CallerMetadata {
  operation: 'chat' | 'stream';
  platform: string;
  model: string; // routed/served model id, as sent upstream
  requestedModel?: string;
  endpoint: string; // 'chat/completions', ...
  attempt?: number;
  input?: unknown;
  output?: unknown;
  samplingParameters?: Record<string, unknown>;
  usage?: { input?: number; output?: number; total?: number };
  usageSource?: UsageSource;
  responseModel?: string;
  finishReasons?: string[];
  ttfbMs?: number;
  latencyMs?: number;
}

function setIfPresent(attrs: Record<string, number | string>, key: string, value: string | number | null | undefined): void {
  if (value == null || value === '') return;
  attrs[key] = value;
}

/** Caller identity + request metadata. Applied on both the root request span
 *  and each generation so Langfuse shows IP/account on the observation itself. */
export function callerAttrs(input: CallerMetadata): Record<string, number | string> {
  const attrs: Record<string, number | string> = {};
  const account = input.accountEmail || (input.accountId != null ? `user:${input.accountId}` : undefined);
  setIfPresent(attrs, 'langfuse.user.id', account);
  setIfPresent(attrs, 'user.id', account);
  setIfPresent(attrs, 'client.address', input.clientIp);
  setIfPresent(attrs, 'user_agent.original', input.userAgent);
  setIfPresent(attrs, 'langfuse.trace.metadata.client_ip', input.clientIp);
  setIfPresent(attrs, 'langfuse.trace.metadata.account', account);
  setIfPresent(attrs, 'langfuse.observation.metadata.client_ip', input.clientIp);
  setIfPresent(attrs, 'langfuse.observation.metadata.account', account);
  setIfPresent(attrs, 'langfuse.observation.metadata.user_agent', input.userAgent);
  setIfPresent(attrs, 'langfuse.observation.metadata.client_agent', input.clientAgent);
  setIfPresent(attrs, 'freellmapi.client_ip', input.clientIp);
  setIfPresent(attrs, 'freellmapi.account', account);
  setIfPresent(attrs, 'freellmapi.user_agent', input.userAgent);
  if (input.accountId != null) {
    attrs['langfuse.trace.metadata.account_id'] = input.accountId;
    attrs['langfuse.observation.metadata.account_id'] = input.accountId;
    attrs['freellmapi.account_id'] = input.accountId;
  }
  setIfPresent(attrs, 'langfuse.observation.metadata.provider_key', input.providerKeyLabel);
  setIfPresent(attrs, 'freellmapi.provider_key', input.providerKeyLabel);
  if (input.providerKeyId != null) {
    attrs['langfuse.observation.metadata.provider_key_id'] = input.providerKeyId;
    attrs['freellmapi.provider_key_id'] = input.providerKeyId;
  }
  return attrs;
}

const MAX_VALUE_LENGTH = 200_000;

function truncateJson(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  if (text.length > maxLength) return `${text.slice(0, maxLength)}\n…[truncated by freellmapi]`;
  return text;
}

/** The span-name for a generation — `openrouter.chat.completions`. The model id
 *  never rides in the name (it can be huge or oddly punny); it goes in
 *  attributes, as requested. */
export function generationSpanName(platform: string, endpoint: string): string {
  const cleaned = endpoint.trim().replace(/^\/+/, '').replace(/\/+/g, '.').replace(/[^\w.-]/g, '_');
  return `${platform}.${cleaned || 'generation'}`;
}

/** Attributes a generation is STARTed with (everything known before dispatch). */
export function startAttrs(input: GenerationAttributes): Record<string, number | string> {
  const attrs: Record<string, number | string> = {
    'langfuse.observation.type': 'generation',
    'langfuse.observation.model.name': input.model,
    'gen_ai.system': input.platform,
    'gen_ai.request.model': input.requestedModel || input.model,
    'freellmapi.provider': input.platform,
    'freellmapi.endpoint': input.endpoint,
  };
  if (input.requestedModel) attrs['freellmapi.requested_model'] = input.requestedModel;
  if (input.attempt != null) attrs['freellmapi.attempt'] = input.attempt;
  Object.assign(attrs, callerAttrs(input));
  attrs['gen_ai.operation.name'] = input.operation;
  if (input.samplingParameters && Object.keys(input.samplingParameters).length > 0) {
    const params = truncateJson(input.samplingParameters, 4096);
    if (params) attrs['langfuse.observation.model.parameters'] = params;
  }
  return attrs;
}

/** Attributes added when the generation ends or errors. `captureInput` /
 *  `captureOutput` gate the payloads; metadata is always recorded. */
export function finishAttrs(
  input: GenerationAttributes,
  captureInput: boolean,
  captureOutput: boolean,
): Record<string, number | string | string[]> {
  const attrs: Record<string, number | string | string[]> = {};
  if (input.responseModel) attrs['gen_ai.response.model'] = input.responseModel;
  if (input.finishReasons && input.finishReasons.length > 0) attrs['gen_ai.response.finish_reasons'] = input.finishReasons;
  if (input.usage) {
    if (input.usage.input != null) attrs['gen_ai.usage.input_tokens'] = input.usage.input;
    if (input.usage.output != null) attrs['gen_ai.usage.output_tokens'] = input.usage.output;
    const details = truncateJson({ input: input.usage.input ?? 0, output: input.usage.output ?? 0, total: input.usage.total ?? 0 }, 1024);
    if (details) attrs['langfuse.observation.usage_details'] = details;
    attrs['freellmapi.usage_source'] = input.usageSource ?? 'provider';
  }
  if (input.ttfbMs != null) attrs['freellmapi.ttfb_ms'] = input.ttfbMs;
  if (input.latencyMs != null) attrs['freellmapi.latency_ms'] = input.latencyMs;
  if (captureInput && input.input !== undefined) {
    const text = truncateJson(input.input, MAX_VALUE_LENGTH);
    if (text) attrs['langfuse.observation.input'] = text;
  }
  if (captureOutput && input.output !== undefined) {
    const text = truncateJson(input.output, MAX_VALUE_LENGTH);
    if (text) attrs['langfuse.observation.output'] = text;
  }
  return attrs;
}

/** Error attributes — the full message (redaction is the caller's choice) plus
 *  the HTTP status when the adapter carried one. Stack is captured by
 *  span.recordException in the observer. */
export function errorAttrs(error: unknown, statusCode?: number): Record<string, number | string> {
  const attrs: Record<string, number | string> = {};
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  if (message) attrs['freellmapi.error.message'] = message;
  if (statusCode != null) attrs['http.response.status_code'] = statusCode;
  return attrs;
}