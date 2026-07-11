import crypto from 'crypto';
import BetterSqlite from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMigrationsSync } from './migrate/runner.js';
import { initEncryptionKey, isEncryptionKeyInitialized } from '../lib/crypto.js';
import { getCurrentUserId, requireUserId } from '../lib/request-context.js';
import type { Db, DbFactory } from './types.js';

export type { Db, DbFactory } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');

let db: Db;

export function getDb(): Db {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() or connectDb() first.');
  }
  return db;
}

export function getDefaultDbPath(): string {
  return process.env.FREEAPI_DB_PATH?.trim() || DB_PATH;
}

/** Default factory: opens a better-sqlite3 connection at the given path. */
function betterSqliteFactory(resolvedPath: string): Db {
  return new BetterSqlite(resolvedPath) as unknown as Db;
}

export function connectDb(
  dbPath?: string,
  opts?: {
    /** Create the parent directory if absent. Default: true. Set false in
     *  environments that do not have a writable local filesystem. */
    ensureDir?: boolean;
    /** Factory that constructs the raw Db connection. Default: better-sqlite3. */
    factory?: DbFactory;
  },
): Db {
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const isMemory = resolvedPath === ':memory:';
  const ensureDir = opts?.ensureDir ?? true;
  const factory = opts?.factory ?? betterSqliteFactory;

  if (!isMemory && ensureDir) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  db = factory(resolvedPath);
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  console.log(`Database initialized at ${resolvedPath}`);
  return db;
}

export function initDb(
  dbPath?: string,
  opts?: { ensureDir?: boolean; factory?: DbFactory },
): Db {
  const db = connectDb(dbPath, opts);

  if (process.env.NODE_ENV !== 'development') {
    runMigrationsSync(db, 'up');
  } else {
    // In dev, verify the DB has been initialised. If not, give a clear error.
    const ready = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'"
    ).get();
    if (!ready) {
      console.error(
        '\n  [dev] Database not initialised. Run:\n\n' +
        '    npm run db:migration:up\n\n' +
        '  Then restart the server.\n'
      );
      process.exit(1);
    }
  }

  if (!isEncryptionKeyInitialized()) initEncryptionKey(db);

  return db;
}

function mintUnifiedKey(): string {
  return `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
}

/** Resolve the dashboard/API user that owns this unified key, or null. */
export function resolveUserFromApiKey(token: string | undefined | null): { userId: number; key: string } | null {
  if (!token) return null;
  const row = getDb().prepare('SELECT user_id, key FROM user_api_keys WHERE key = ?')
    .get(token) as { user_id: number; key: string } | undefined;
  if (!row) return null;
  return { userId: row.user_id, key: row.key };
}

/** Ensure the user has a unified key; return it. */
export function getOrCreateUserApiKey(userId: number): string {
  const db = getDb();
  const existing = db.prepare('SELECT key FROM user_api_keys WHERE user_id = ?')
    .get(userId) as { key: string } | undefined;
  if (existing) return existing.key;
  const key = mintUnifiedKey();
  db.prepare('INSERT INTO user_api_keys (user_id, key) VALUES (?, ?)').run(userId, key);
  return key;
}

export function regenerateUserApiKey(userId: number): string {
  const db = getDb();
  const key = mintUnifiedKey();
  db.prepare(`
    INSERT INTO user_api_keys (user_id, key) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET key = excluded.key
  `).run(userId, key);
  return key;
}

/**
 * @deprecated Prefer getOrCreateUserApiKey(requireUserId()). Kept for tests /
 * call sites that still expect a single string during the multi-user transition.
 */
export function getUnifiedApiKey(): string {
  return getOrCreateUserApiKey(requireUserId());
}

export function regenerateUnifiedKey(): string {
  return regenerateUserApiKey(requireUserId());
}

// ── Instance (shared) settings ──────────────────────────────────────────────

export function getInstanceSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM instance_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setInstanceSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO instance_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

const INSTANCE_SETTING_KEYS = new Set([
  'proxy_url',
  'proxy_enabled',
  'proxy_bypass',
  'premium_license_key',
  'premium_license_status',
  'catalog_applied_version',
  'catalog_applied_tier',
  'catalog_applied_json',
  'catalog_last_sync_ms',
  'catalog_last_error',
  'enrollment_invite_code',
]);

export function isInstanceSettingKey(key: string): boolean {
  return INSTANCE_SETTING_KEYS.has(key) || key.startsWith('catalog_');
}

// Generic key/value settings accessors (per-user when context is bound).
export function getSetting(key: string, userId?: number): string | undefined {
  if (isInstanceSettingKey(key)) {
    return getInstanceSetting(key);
  }
  let uid = userId ?? getCurrentUserId();
  if (uid == null) {
    // Same single-user / bootstrap resolution as requireUserId, without
    // throwing when the DB truly has no operator yet.
    try {
      uid = requireUserId();
    } catch {
      return getInstanceSetting(key);
    }
  }
  const row = getDb().prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?')
    .get(uid, key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string, userId?: number): void {
  if (isInstanceSettingKey(key)) {
    setInstanceSetting(key, value);
    return;
  }
  const uid = userId ?? requireUserId();
  getDb().prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(uid, key, value);
}
