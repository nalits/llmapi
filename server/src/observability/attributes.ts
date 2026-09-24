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
// GenAI semantic-convention attrs give the same data its portable spelling.
// No user identity is ever captured.

export type UsageSource = 'provider' | 'estimated';

export interface GenerationAttributes {
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