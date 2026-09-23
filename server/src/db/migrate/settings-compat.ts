import type { Db } from '../types.js';

/** True when isolation has rebuilt settings as (user_id, key). */
export function settingsHasUserId(db: Db): boolean {
  const cols = db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>;
  return cols.some(c => c.name === 'user_id');
}

export function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function userIds(db: Db): number[] {
  return (db.prepare('SELECT id FROM users ORDER BY id ASC').all() as Array<{ id: number }>)
    .map(r => r.id);
}

/** Read a setting, preferring instance_settings after isolation. */
export function readSettingValue(db: Db, key: string): string | undefined {
  if (tableExists(db, 'instance_settings')) {
    const inst = db.prepare('SELECT value FROM instance_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    if (inst) return inst.value;
  }
  if (settingsHasUserId(db)) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function deleteSettingByKey(db: Db, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** Insert a per-user setting for every account (or the pre-isolation single row). */
export function insertSettingForUsers(db: Db, key: string, value: string): void {
  if (!settingsHasUserId(db)) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
    ).run(key, value);
    return;
  }
  const insert = db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO NOTHING
  `);
  for (const uid of userIds(db)) {
    insert.run(uid, key, value);
  }
}

export function upsertSettingForUsers(db: Db, key: string, value: string): void {
  if (!settingsHasUserId(db)) {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
    return;
  }
  const upsert = db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `);
  for (const uid of userIds(db)) {
    upsert.run(uid, key, value);
  }
}
