// Trace-level sampling. The decision IS the trace: once a request is sampled
// (or not), every fallback attempt of that request inherits the verdict, so a
// failover chain is never torn in half by per-span sampling.
//
// Deterministic per requestId (FNV-1a over the id → [0,1)) so a given request
// always lands the same way — this is what makes sampling unit-testable. A
// missing requestId (no group id, no inbound header) falls back to Math.random.

/** FNV-1a 32-bit hash of an ASCII string, normalized to [0,1). */
function fnv1a01(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0xffffffff;
}

export function shouldSample(sampleRate: number, requestId?: string | null): boolean {
  if (!Number.isFinite(sampleRate)) return true;
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const roll = requestId ? fnv1a01(requestId) : Math.random();
  return roll < sampleRate;
}