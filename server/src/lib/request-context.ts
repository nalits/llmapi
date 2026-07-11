import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { getDb } from '../db/index.js';

export interface RequestContext {
  userId: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given user bound for the rest of the async chain. */
export function runWithUser<T>(userId: number, fn: () => T): T {
  return storage.run({ userId }, fn);
}

/** Current request user id, or undefined when no context is bound. */
export function getCurrentUserId(): number | undefined {
  return storage.getStore()?.userId;
}

function mintUnifiedKey(): string {
  return `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
}

function claimOrphans(userId: number): void {
  const db = getDb();
  db.prepare('UPDATE api_keys SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE fallback_config SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE profiles SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE requests SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare("UPDATE models SET user_id = ? WHERE platform = 'custom' AND user_id IS NULL").run(userId);
}

/**
 * Create a minimal operator account when services are called with an empty
 * users table (unit tests / scripts after initDb). Avoids importing auth.ts
 * (circular with db).
 */
function bootstrapOperatorUser(): number {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO users (email, password_hash, is_admin) VALUES ('operator@localhost', 'bootstrap', 1)",
  ).run();
  const userId = Number(result.lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO user_api_keys (user_id, key) VALUES (?, ?)').run(userId, mintUnifiedKey());
  claimOrphans(userId);
  // Inherit catalog enabled flags until the user toggles (no blanket seed).
  const hasDefault = db.prepare(
    "SELECT id FROM profiles WHERE user_id = ? AND type = 'default' LIMIT 1",
  ).get(userId) as { id: number } | undefined;
  let profileId = hasDefault?.id;
  if (!profileId) {
    const profile = db.prepare(
      "INSERT INTO profiles (name, emoji, color, type, sort_order, user_id) VALUES ('Default', '⚙️', '#6366f1', 'default', -1, ?)",
    ).run(userId);
    profileId = Number(profile.lastInsertRowid);
    db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      SELECT ?, model_db_id, priority, enabled FROM fallback_config WHERE user_id = ? ORDER BY priority ASC
    `).run(profileId, userId);
  }
  db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, 'active_profile_id', ?)
    ON CONFLICT(user_id, key) DO NOTHING
  `).run(userId, String(profileId));
  db.prepare(`
    INSERT INTO instance_settings (key, value) VALUES ('enrollment_invite_code', ?)
    ON CONFLICT(key) DO NOTHING
  `).run('TESTINVITE1');
  return userId;
}

/**
 * Require a bound user id. If AsyncLocalStorage is unset:
 * - exactly one account → use it (single-operator scripts / most unit tests)
 * - zero accounts → bootstrap a local operator (initDb-only unit tests)
 * - multiple accounts → throw (must bind context to avoid cross-tenant leaks)
 */
export function requireUserId(): number {
  const bound = getCurrentUserId();
  let userId: number | undefined = bound;

  if (userId == null) {
    try {
      const rows = getDb().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 2').all() as Array<{ id: number }>;
      if (rows.length === 1) userId = rows[0]!.id;
      else if (rows.length === 0) userId = bootstrapOperatorUser();
    } catch {
      // DB not ready
    }
  }

  if (userId == null) {
    throw new Error('No user context bound for this request');
  }

  // Unit tests often INSERT api_keys without user_id after bootstrapping the
  // sole operator. Adopt orphans whenever there is only one account.
  try {
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    if (count === 1) claimOrphans(userId);
  } catch {
    // ignore
  }

  return userId;
}
