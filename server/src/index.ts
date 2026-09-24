import './env.js';
import { createApp } from './app.js';
import { initDb, getDb } from './db/index.js';
import { startHealthChecker, checkAllKeys } from './services/health.js';
import { restoreProxySettings, flushProxyCache } from './lib/proxy.js';
import { startWakeDetect } from './lib/wake-detect.js';
import { startCatalogSync } from './services/catalog-sync.js';
import { startCooldownProbe } from './services/cooldown-probe.js';
import { startCustomModelSync } from './services/custom-model-sync.js';
import { installProcessSafetyNet } from './lib/process-safety-net.js';
import { NodeScheduler } from './lib/scheduler.js';
import { loadConfig } from './lib/config.js';
import { initObservability, loadObservabilityConfig, shutdownObservability } from './observability/index.js';
import { applyDeclarativeConfigFromEnv } from './services/declarative-config.js';
import { restoreDbBackupIfNeeded, startDbBackupPump } from './lib/db-backup.js';
import { startBackupScheduler } from './services/backups.js';
import { userCount, logEnrollmentSetupCode } from './services/auth.js';
import { generateSetupCode } from './lib/setup-code.js';
import { warnOnEnvDrift } from './lib/env-drift.js';
import { warnOnRoutingOverrideDrift } from './services/model-weight-overrides.js';
import { installLogRedaction } from './lib/log-redaction.js';
import { cleanupExpiredCooldowns } from './services/ratelimit.js';
import { loadCacheFromDb } from './services/cache.js';

// Before any other statement runs, so no provider key can reach stdout — users
// paste server output into bug reports. Module scope, not inside main(), so it
// is active for the whole process lifetime including startup logging.
installLogRedaction();

async function main() {
  const config = loadConfig();
  const { port: PORT, host: HOST } = config;
  warnOnEnvDrift();

  // Observability is opt-in, fail-open, additive: it must never change how
  // requests are handled. Disabled or incomplete credentials log a warning (or
  // nothing) and the gateway serves exactly as before.
  const startedObservability = initObservability(loadObservabilityConfig());

  // Only when the SDK is actually running do we flag for a bounded flush on
  // SIGTERM/SIGINT — last spans shouldn't vanish with the process. When
  // observability is off these handlers are not registered and shutdown behaves
  // exactly as it always did.
  if (startedObservability.started) {
    let flushing = false;
    const gracefulExit = (signal: string) => {
      if (flushing) return;
      flushing = true;
      console.log(`[observability] ${signal} — flushing spans before exit`);
      void shutdownObservability().finally(() => process.exit(0));
    };
    process.once('SIGTERM', () => gracefulExit('SIGTERM'));
    process.once('SIGINT', () => gracefulExit('SIGINT'));
  }

  // Install first so a late provider socket reset (undici HTTP/2 error with no
  // listener) can't take the proxy down. Genuine bugs still exit 1.
  installProcessSafetyNet();

  const scheduler = new NodeScheduler();

  if (config.dbPath) {
    await restoreDbBackupIfNeeded(config.dbPath);
  } else {
    await restoreDbBackupIfNeeded();
  }
  initDb(config.dbPath ?? undefined);
  applyDeclarativeConfigFromEnv();
  // After initDb: the unknown-model half of this check reads the catalog.
  warnOnRoutingOverrideDrift();

  // Reload the persisted response cache into the in-memory LRU so entries
  // survive a restart (the daily quota-reset re-run pattern). Best-effort:
  // a DB failure leaves the cache empty (memory-only), exactly as before.
  loadCacheFromDb();

  // Cooldowns persist across restarts on purpose, but their expiry is collected
  // lazily (isOnCooldown, per model+key). Rows for routes nothing asks about
  // again — retired models, deleted keys, a shutdown taken while everything was
  // benched — would otherwise stay in the table forever and weigh down every
  // cooldown rollup. One sweep at boot, while the DB is quiet.
  const expiredCooldowns = cleanupExpiredCooldowns();
  if (expiredCooldowns > 0) {
    console.log(`[ratelimit] cleared ${expiredCooldowns} expired cooldown${expiredCooldowns === 1 ? '' : 's'}`);
  }

  // Setup-code gate: unclaimed installs mint a first-run code (loopback can
  // skip it; remote must present it). After an admin exists, log the shared
  // enrollment setup code so every later signup can use the same secret.
  if (userCount() === 0) {
    generateSetupCode();
  } else {
    logEnrollmentSetupCode();
  }

  // Load the persisted proxy settings from the DB (env var wins if set).
  // Must happen after initDb so the settings table is ready.
  restoreProxySettings();

  const app = createApp(config);

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`Server running on http://${display}:${PORT}`);
    console.log(`Proxy endpoint: http://${display}:${PORT}/v1/chat/completions`);
    startHealthChecker(scheduler);
    startCatalogSync(scheduler);
    startCooldownProbe(scheduler);
    startDbBackupPump(getDb(), scheduler, config.dbPath ?? undefined);
    startBackupScheduler(scheduler);
    startCustomModelSync(getDb(), scheduler);

    // Post-sleep recovery: while the host was suspended (laptop lid, VM
    // pause) timers and keep-alive sockets froze, so the first requests after
    // wake used to hit dead pooled connections and pre-sleep key statuses
    // until the 5-minute health cycle caught up. On a detected wake (>30s
    // wall-clock drift, or SIGCONT/SIGUSR1/2), drop the proxy dispatcher's
    // pooled sockets and re-probe every key immediately.
    startWakeDetect({
      async onWake(event) {
        const idle = Math.round(event.idleMs / 1000);
        console.log(`[wake] resumed after ~${idle}s (${event.reason}${event.signal ? `:${event.signal}` : ''}) — flushing stale sockets, re-probing keys`);
        flushProxyCache();
        try {
          // Forced: every status predates the sleep, so the recency skip and
          // provider spacing of a scheduled pass would only delay the picture.
          await checkAllKeys({ force: true });
        } catch (err: any) {
          console.error(`[wake] post-wake key re-probe failed: ${err?.message ?? err}`);
        }
      },
    });
  };

  // Keep idle sockets open LONGER than any fronting reverse proxy keeps them
  // in its pool. Node's default keepAliveTimeout is 5s while Caddy (and nginx)
  // reuse idle upstream connections for 30-60s, so the proxy periodically
  // writes a request into a socket this server just closed and surfaces it to
  // the user as a 502 "connection reset by peer". 75s clears both defaults;
  // headersTimeout must stay above keepAliveTimeout or Node times the
  // keep-alive socket out while the next request's headers are in flight.
  const tuneKeepAlive = (s: ReturnType<typeof app.listen>) => {
    s.keepAliveTimeout = 75_000;
    s.headersTimeout = 76_000;
  };

  const server = app.listen(Number(PORT), HOST, onReady(HOST));
  tuneKeepAlive(server);
  server.on('error', (err: NodeJS.ErrnoException) => {
    // The default '::' bind fails where IPv6 is disabled (kernel
    // ipv6.disable=1 and the like) — retry IPv4-only rather than dying.
    // Anything else (EADDRINUSE, an explicit HOST that can't bind) keeps the
    // fail-fast posture documented in main().catch below.
    if (!process.env.HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[server] IPv6 unavailable on this host — falling back to 0.0.0.0 (IPv4-only)');
      tuneKeepAlive(app.listen(Number(PORT), '0.0.0.0', onReady('0.0.0.0')));
      return;
    }
    console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
}

main().catch((err) => {
  // A boot failure (e.g. a missing production ENCRYPTION_KEY) must exit
  // non-zero rather than leaving a half-initialized process that never starts
  // listening — that silent state is what surfaces in the client as
  // "Can't reach the server".
  console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
  process.exit(1);
});
