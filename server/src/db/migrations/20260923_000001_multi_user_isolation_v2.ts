// Migration: multi_user_isolation_v2
// Created: 2026-09-23
//
// Adds user_id to tables introduced after the original 20260711 isolation
// migration. DOWN is irreversible.

import type { Db } from '../types.js';

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

function addUserId(db: Db, table: string): void {
  if (!tableExists(db, table) || columnExists(db, table, 'user_id')) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
  const first = firstUserId(db);
  if (first != null) {
    db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(first);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table}(user_id)`);
}

export function up(db: Db): void {
  addUserId(db, 'client_profiles');
  addUserId(db, 'url_tokens');
  addUserId(db, 'playground_conversations');
  addUserId(db, 'response_cache');

  if (tableExists(db, 'idempotency_claims') && !columnExists(db, 'idempotency_claims', 'user_id')) {
    db.exec(`
      CREATE TABLE idempotency_claims_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        execution_id TEXT,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        UNIQUE(user_id, key_hash)
      )
    `);
    const first = firstUserId(db);
    if (first != null) {
      db.exec(`
        INSERT INTO idempotency_claims_new
          (id, user_id, key_hash, request_fingerprint, response_status, response_body, execution_id, created_at_ms, expires_at_ms)
        SELECT id, ${first}, key_hash, request_fingerprint, response_status, response_body, execution_id, created_at_ms, expires_at_ms
        FROM idempotency_claims
      `);
    }
    db.exec('DROP TABLE idempotency_claims');
    db.exec('ALTER TABLE idempotency_claims_new RENAME TO idempotency_claims');
    db.exec('CREATE INDEX IF NOT EXISTS idx_idempotency_claims_expires ON idempotency_claims(expires_at_ms)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_idempotency_claims_user ON idempotency_claims(user_id)');
  }

  if (tableExists(db, 'custom_model_tombstones') && !columnExists(db, 'custom_model_tombstones', 'user_id')) {
    db.exec(`
      CREATE TABLE custom_model_tombstones_new (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        endpoint_scope TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, endpoint_scope, model_id)
      )
    `);
    const first = firstUserId(db);
    if (first != null) {
      db.exec(`
        INSERT INTO custom_model_tombstones_new (user_id, endpoint_scope, model_id, created_at)
        SELECT ${first}, endpoint_scope, model_id, created_at FROM custom_model_tombstones
      `);
    }
    db.exec('DROP TABLE custom_model_tombstones');
    db.exec('ALTER TABLE custom_model_tombstones_new RENAME TO custom_model_tombstones');
  }
}

export function down(_db: Db): void {
  throw new Error('irreversible migration: multi_user_isolation_v2');
}
