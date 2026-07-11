import crypto from 'crypto';
import { getDb, getOrCreateUserApiKey, getInstanceSetting, setInstanceSetting } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

// Dashboard authentication: email + password accounts with opaque session
// tokens. Distinct from the per-user unified API key, which authenticates the
// /v1 proxy for apps — this gates the /api/* admin surface for operators.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LENGTH = 10;

export interface SessionUser {
  userId: number;
  email: string;
  isAdmin: boolean;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return row.c;
}

export function mintInviteCode(): string {
  const bytes = crypto.randomBytes(INVITE_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    out += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length];
  }
  return out;
}

export function getEnrollmentInviteCode(): string | null {
  return getInstanceSetting('enrollment_invite_code') ?? null;
}

/** Persist enrollment code, preferring an explicit seed (e.g. the first-run setup code). */
export function ensureEnrollmentInviteCode(seed?: string | null): string {
  const existing = getEnrollmentInviteCode();
  if (existing) return existing;
  const code = (seed && seed.trim()) ? seed.trim().toUpperCase() : mintInviteCode();
  setInstanceSetting('enrollment_invite_code', code);
  return code;
}

/** Log the shared setup code used for every new account after the first. */
export function logEnrollmentSetupCode(): string {
  const code = ensureEnrollmentInviteCode();
  console.log('');
  console.log('  Setup code (required to create accounts): ' + code);
  console.log('  Share this with people who should join this FreeLLMAPI instance.');
  console.log('  Admins can also view or rotate it under Keys → Setup code.');
  console.log('');
  return code;
}

export function rotateEnrollmentInviteCode(): string {
  const code = mintInviteCode();
  setInstanceSetting('enrollment_invite_code', code);
  return code;
}

export function inviteCodeMatches(provided: unknown): boolean {
  const current = getEnrollmentInviteCode();
  if (!current || typeof provided !== 'string') return false;
  const a = Buffer.from(current);
  const normalized = Buffer.from(provided.trim().toUpperCase());
  if (a.length !== normalized.length) return false;
  return crypto.timingSafeEqual(a, normalized);
}

/**
 * Seed per-user defaults after account creation: unified API key, Default
 * profile, active_profile_id, fallback chain, model enablement, and (for
 * admin) invite code.
 */
export function bootstrapUserWorkspace(userId: number, opts?: { isAdmin?: boolean }): void {
  const db = getDb();
  if (opts?.isAdmin) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
  }

  getOrCreateUserApiKey(userId);

  // Claim any pre-user catalog fallback rows left by a fresh migration.
  db.prepare('UPDATE fallback_config SET user_id = ? WHERE user_id IS NULL').run(userId);

  // Do NOT pre-seed user_model_enabled for every catalog row — absence means
  // "inherit models.enabled". Rows are written only when the user toggles.

  // Seed fallback chain for catalog models (and this user's customs).
  const maxPri = (db.prepare(
    'SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config WHERE user_id = ?'
  ).get(userId) as { mx: number }).mx;
  const missing = db.prepare(`
    SELECT m.id FROM models m
    WHERE (m.user_id IS NULL OR m.user_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM fallback_config f
        WHERE f.user_id = ? AND f.model_db_id = m.id
      )
    ORDER BY m.intelligence_rank ASC, m.id ASC
  `).all(userId, userId) as Array<{ id: number }>;
  const insertFb = db.prepare(
    'INSERT INTO fallback_config (user_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)'
  );
  missing.forEach((row, i) => insertFb.run(userId, row.id, maxPri + i + 1));

  // Default profile for this user (one per user).
  const existingDefault = db.prepare(
    "SELECT id FROM profiles WHERE user_id = ? AND type = 'default' LIMIT 1"
  ).get(userId) as { id: number } | undefined;

  let profileId = existingDefault?.id;
  if (!profileId) {
    const result = db.prepare(
      "INSERT INTO profiles (name, emoji, color, type, sort_order, user_id) VALUES ('Default', '⚙️', '#6366f1', 'default', -1, ?)"
    ).run(userId);
    profileId = Number(result.lastInsertRowid);

    db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      SELECT ?, model_db_id, priority, enabled
      FROM fallback_config
      WHERE user_id = ?
      ORDER BY priority ASC
    `).run(profileId, userId);
  }

  db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, 'active_profile_id', ?)
    ON CONFLICT(user_id, key) DO NOTHING
  `).run(userId, String(profileId));

  if (opts?.isAdmin) {
    ensureEnrollmentInviteCode();
  }
}

/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export function createUser(email: string, password: string, opts?: { isAdmin?: boolean }): SessionUser {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  // First account on the instance is always admin.
  const isAdmin = opts?.isAdmin ?? userCount() === 0;
  const result = db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(normalized, hashPassword(password), isAdmin ? 1 : 0);
  const userId = Number(result.lastInsertRowid);
  bootstrapUserWorkspace(userId, { isAdmin });
  return { userId, email: normalized, isAdmin };
}

/** Verify credentials. Returns the user on success, null on failure. */
export function verifyCredentials(email: string, password: string): SessionUser | null {
  const db = getDb();
  const row = db.prepare('SELECT id, email, password_hash, is_admin FROM users WHERE email = ?')
    .get(normalizeEmail(email)) as { id: number; email: string; password_hash: string; is_admin: number } | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { userId: row.id, email: row.email, isAdmin: !!row.is_admin };
}

/** Mint a session and return the raw token (only the hash is persisted). */
export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

/** Resolve a session token to its user, or null if missing/expired. */
export function validateSession(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT s.user_id, s.expires_at_ms, u.email, u.is_admin
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token)) as { user_id: number; expires_at_ms: number; email: string; is_admin: number } | undefined;
  if (!row) return null;
  if (row.expires_at_ms < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { userId: row.user_id, email: row.email, isAdmin: !!row.is_admin };
}

export function deleteSession(token: string | undefined | null): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}
