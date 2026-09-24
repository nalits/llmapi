// Observability public API. Import this module (not the internals) from the
// rest of the server.
//
// Fail-open by construction: nothing here throws, the SDK is only started when
// LANGFUSE_ENABLED=true with complete credentials, and every provider observer
// no-ops when there is no active sampled request.

import { loadObservabilityConfig, type LangfuseObservabilityConfig } from './config.js';
import { setObservabilityConfig } from './llm-observer.js';
import { getObservabilityConfig } from './llm-observer.js';

export { loadObservabilityConfig };
export type { LangfuseObservabilityConfig };

// Bind the env-derived config once at module load so observers never have to
// re-read process.env on the hot path. Tests can override with setObservabilityConfig.
setObservabilityConfig(loadObservabilityConfig());
export { getObservabilityConfig, setObservabilityConfig };

export { initObservability, shutdownObservability, isObservabilityStarted, getTracer } from './otel.js';
export {
  beginRequest,
  withRequestObservability,
  finishRequest,
  getRequestObservability,
  type RequestObservability,
  type RequestObservabilityContext,
  type FinishRequestOptions,
} from './context.js';
export { observeGeneration, type GenerationHandle, type ObserveGenerationInput } from './llm-observer.js';
export { shouldSample } from './sampling.js';
export {
  generationSpanName,
  type GenerationAttributes,
  type UsageSource,
} from './attributes.js';