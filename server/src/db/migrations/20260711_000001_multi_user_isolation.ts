// Migration: multi_user_isolation
// Created: 2026-07-11
//
// DOWN: irreversible — drops/rebuilds tables with user scoping; data shape changes.

import crypto from 'crypto';
import type { Db } from '../types.js';

const INSTANCE_SETTING_KEYS = [
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
] as const;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function mintInviteCode(): string {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

function mintUnifiedKey(): string {
  return `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
}

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnExists(db: Db, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

function firstUserId(db: Db): number | null {
  const row = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined;
  return row?.id ?? null;
}

export function up(db: Db): void {
  // ── users.is_admin ────────────────────────────────────────────────────────
  if (!columnExists(db, 'users', 'is_admin')) {
    db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  }
  const first = firstUserId(db);
  if (first != null) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(first);
  }

  // ── instance_settings ─────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Move shared keys out of settings (if present).
  for (const key of INSTANCE_SETTING_KEYS) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (row) {
      db.prepare(`
        INSERT INTO instance_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, row.value);
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    }
  }

  // Ensure invite code exists once an account exists (or mint now for empty installs —
  // register path also mints if missing).
  if (first != null) {
    const existing = db.prepare(
      "SELECT value FROM instance_settings WHERE key = 'enrollment_invite_code'"
    ).get() as { value: string } | undefined;
    if (!existing) {
      db.prepare(
        "INSERT INTO instance_settings (key, value) VALUES ('enrollment_invite_code', ?)"
      ).run(mintInviteCode());
    }
  }

  // ── user_api_keys ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_api_keys (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  if (first != null) {
    const unified = db.prepare(
      "SELECT value FROM settings WHERE key = 'unified_api_key'"
    ).get() as { value: string } | undefined;
    const key = unified?.value ?? mintUnifiedKey();
    db.prepare(`
      INSERT INTO user_api_keys (user_id, key) VALUES (?, ?)
      ON CONFLICT(user_id) DO NOTHING
    `).run(first, key);
    db.prepare("DELETE FROM settings WHERE key = 'unified_api_key'").run();
  }

  // ── Rebuild settings as (user_id, key) ────────────────────────────────────
  if (!columnExists(db, 'settings', 'user_id')) {
    db.exec(`
      CREATE TABLE settings_new (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      )
    `);
    if (first != null) {
      const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
      const insert = db.prepare('INSERT INTO settings_new (user_id, key, value) VALUES (?, ?, ?)');
      for (const row of rows) {
        insert.run(first, row.key, row.value);
      }
    }
    db.exec(`DROP TABLE settings`);
    db.exec(`ALTER TABLE settings_new RENAME TO settings`);
  }

  // ── api_keys.user_id ──────────────────────────────────────────────────────
  if (!columnExists(db, 'api_keys', 'user_id')) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
    if (first != null) {
      db.prepare('UPDATE api_keys SET user_id = ? WHERE user_id IS NULL').run(first);
    } else {
      // No users yet — drop orphan keys (fresh install with keys is impossible
      // via UI, but be safe for odd states).
      db.prepare('DELETE FROM api_keys WHERE user_id IS NULL').run();
    }
    // SQLite can't easily add NOT NULL after the fact with FK; leave nullable for
    // empty-DB edge case. Application always sets user_id on insert.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_user_platform ON api_keys(user_id, platform)`);
  }

  // ── profiles.user_id ──────────────────────────────────────────────────────
  if (!columnExists(db, 'profiles', 'user_id')) {
    db.exec(`ALTER TABLE profiles ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
    if (first != null) {
      db.prepare('UPDATE profiles SET user_id = ? WHERE user_id IS NULL').run(first);
    } else {
      db.prepare('DELETE FROM profiles WHERE user_id IS NULL').run();
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id)`);
  }

  // ── fallback_config.user_id ───────────────────────────────────────────────
  if (!columnExists(db, 'fallback_config', 'user_id')) {
    // Rebuild to change UNIQUE(model_db_id) → UNIQUE(user_id, model_db_id)
    db.exec(`
      CREATE TABLE fallback_config_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        model_db_id INTEGER NOT NULL REFERENCES models(id),
        priority INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(user_id, model_db_id)
      )
    `);
    if (first != null) {
      db.exec(`
        INSERT INTO fallback_config_new (id, user_id, model_db_id, priority, enabled)
        SELECT id, ${first}, model_db_id, priority, enabled FROM fallback_config
      `);
    } else {
      // Fresh install: keep catalog fallback rows with NULL user_id until the
      // first account is created (bootstrapUserWorkspace claims them).
      db.exec(`
        INSERT INTO fallback_config_new (id, user_id, model_db_id, priority, enabled)
        SELECT id, NULL, model_db_id, priority, enabled FROM fallback_config
      `);
    }
    db.exec(`DROP TABLE fallback_config`);
    db.exec(`ALTER TABLE fallback_config_new RENAME TO fallback_config`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_fallback_config_user ON fallback_config(user_id)`);
  }

  // ── requests.user_id ──────────────────────────────────────────────────────
  if (!columnExists(db, 'requests', 'user_id')) {
    db.exec(`ALTER TABLE requests ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    if (first != null) {
      db.prepare('UPDATE requests SET user_id = ? WHERE user_id IS NULL').run(first);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_user_created ON requests(user_id, created_at)`);
  }

  // ── request_hourly rebuild with user_id ───────────────────────────────────
  if (tableExists(db, 'request_hourly') && !columnExists(db, 'request_hourly', 'user_id')) {
    db.exec(`
      CREATE TABLE request_hourly_new (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hour TEXT NOT NULL,
        total_requests INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, hour)
      )
    `);
    if (first != null) {
      db.exec(`
        INSERT INTO request_hourly_new (user_id, hour, total_requests, success_count, error_count, input_tokens, output_tokens)
        SELECT ${first}, hour, total_requests, success_count, error_count, input_tokens, output_tokens
        FROM request_hourly
      `);
    }
    db.exec(`DROP TABLE request_hourly`);
    db.exec(`ALTER TABLE request_hourly_new RENAME TO request_hourly`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_request_hourly_user_hour ON request_hourly(user_id, hour)`);
  } else if (!tableExists(db, 'request_hourly')) {
    db.exec(`
      CREATE TABLE request_hourly (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hour TEXT NOT NULL,
        total_requests INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, hour)
      )
    `);
  }

  // ── model_overrides / tombstones with user_id ─────────────────────────────
  if (tableExists(db, 'model_overrides') && !columnExists(db, 'model_overrides', 'user_id')) {
    db.exec(`
      CREATE TABLE model_overrides_new (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        overrides_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, platform, model_id)
      )
    `);
    if (first != null) {
      db.exec(`
        INSERT INTO model_overrides_new (user_id, platform, model_id, overrides_json, updated_at)
        SELECT ${first}, platform, model_id, overrides_json, updated_at FROM model_overrides
      `);
    }
    db.exec(`DROP TABLE model_overrides`);
    db.exec(`ALTER TABLE model_overrides_new RENAME TO model_overrides`);
  }

  if (tableExists(db, 'catalog_model_tombstones') && !columnExists(db, 'catalog_model_tombstones', 'user_id')) {
    db.exec(`
      CREATE TABLE catalog_model_tombstones_new (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'chat',
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, kind, platform, model_id)
      )
    `);
    if (first != null) {
      db.exec(`
        INSERT INTO catalog_model_tombstones_new (user_id, kind, platform, model_id, created_at)
        SELECT ${first}, kind, platform, model_id, created_at FROM catalog_model_tombstones
      `);
    }
    db.exec(`DROP TABLE catalog_model_tombstones`);
    db.exec(`ALTER TABLE catalog_model_tombstones_new RENAME TO catalog_model_tombstones`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_model_tombstones_user ON catalog_model_tombstones(user_id, platform, model_id)`);
  }

  // ── custom models: user_id (NULL = shared catalog) ────────────────────────
  if (!columnExists(db, 'models', 'user_id')) {
    db.exec(`ALTER TABLE models ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
    // Catalog rows stay NULL. Custom rows assigned to first user.
    if (first != null) {
      db.prepare("UPDATE models SET user_id = ? WHERE platform = 'custom' AND user_id IS NULL").run(first);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id)`);
  }

  // Per-user enablement for catalog (and optional override for any model).
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_model_enabled (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, model_db_id)
    )
  `);

  // Backfill: copy current models.enabled into first user's junction for all models.
  if (first != null) {
    db.prepare(`
      INSERT OR IGNORE INTO user_model_enabled (user_id, model_db_id, enabled)
      SELECT ?, id, enabled FROM models
      WHERE user_id IS NULL OR user_id = ?
    `).run(first, first);
  }

  // embedding / media custom ownership
  if (tableExists(db, 'embedding_models') && !columnExists(db, 'embedding_models', 'user_id')) {
    db.exec(`ALTER TABLE embedding_models ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
    if (first != null) {
      db.prepare("UPDATE embedding_models SET user_id = ? WHERE key_id IS NOT NULL AND user_id IS NULL").run(first);
    }
  }
  if (tableExists(db, 'media_models') && !columnExists(db, 'media_models', 'user_id')) {
    db.exec(`ALTER TABLE media_models ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
    if (first != null) {
      db.prepare("UPDATE media_models SET user_id = ? WHERE key_id IS NOT NULL AND user_id IS NULL").run(first);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_embedding_model_enabled (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, model_db_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_media_model_enabled (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES media_models(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, model_db_id)
    )
  `);

  if (first != null && tableExists(db, 'embedding_models')) {
    db.prepare(`
      INSERT OR IGNORE INTO user_embedding_model_enabled (user_id, model_db_id, enabled)
      SELECT ?, id, enabled FROM embedding_models
    `).run(first);
  }
  if (first != null && tableExists(db, 'media_models')) {
    db.prepare(`
      INSERT OR IGNORE INTO user_media_model_enabled (user_id, model_db_id, enabled)
      SELECT ?, id, enabled FROM media_models
    `).run(first);
  }
}

export function down(_db: Db): void {
  throw new Error('irreversible migration: multi_user_isolation');
}
