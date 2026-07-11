import type { Db } from '../db/types.js';
import { getCurrentUserId, requireUserId, runWithUser } from '../lib/request-context.js';

export type CatalogModelKind = 'chat' | 'media';

export interface ModelOverridePatch {
  displayName?: string;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  monthlyTokenBudget?: string;
  contextWindow?: number | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
}

type StoredOverrides = Partial<ModelOverridePatch>;

const OVERRIDE_COLUMNS: Record<keyof ModelOverridePatch, string> = {
  displayName: 'display_name',
  intelligenceRank: 'intelligence_rank',
  speedRank: 'speed_rank',
  sizeLabel: 'size_label',
  rpmLimit: 'rpm_limit',
  rpdLimit: 'rpd_limit',
  tpmLimit: 'tpm_limit',
  tpdLimit: 'tpd_limit',
  monthlyTokenBudget: 'monthly_token_budget',
  contextWindow: 'context_window',
  supportsVision: 'supports_vision',
  supportsTools: 'supports_tools',
};

function parseOverrides(raw: string | undefined): StoredOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as StoredOverrides : {};
  } catch {
    return {};
  }
}

function toDbValue(key: keyof ModelOverridePatch, value: unknown): unknown {
  if (key === 'supportsVision' || key === 'supportsTools') return value ? 1 : 0;
  return value;
}

function cleanPatch(patch: ModelOverridePatch): StoredOverrides {
  const cleaned: StoredOverrides = {};
  for (const key of Object.keys(OVERRIDE_COLUMNS) as Array<keyof ModelOverridePatch>) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      cleaned[key] = patch[key] as never;
    }
  }
  return cleaned;
}

export function isCatalogManagedModel(row: { platform: string; key_id?: number | null }): boolean {
  return row.platform !== 'custom' && row.key_id == null;
}

export function isCatalogModelTombstoned(
  db: Db,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
): boolean {
  // Catalog sync runs without a user; per-user tombstones must not block shared inserts.
  const userId = getCurrentUserId();
  if (userId == null) return false;
  return !!db
    .prepare('SELECT 1 FROM catalog_model_tombstones WHERE user_id = ? AND kind = ? AND platform = ? AND model_id = ?')
    .get(userId, kind, platform, modelId);
}

export function recordCatalogModelTombstone(
  db: Db,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
): void {
  const userId = requireUserId();
  db.prepare(`
    INSERT INTO catalog_model_tombstones (user_id, kind, platform, model_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, kind, platform, model_id) DO UPDATE SET created_at = datetime('now')
  `).run(userId, kind, platform, modelId);
  if (kind === 'chat') {
    db.prepare('DELETE FROM model_overrides WHERE user_id = ? AND platform = ? AND model_id = ?').run(userId, platform, modelId);
  }
}

export function clearCatalogModelTombstone(
  db: Db,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
): void {
  const userId = requireUserId();
  db.prepare('DELETE FROM catalog_model_tombstones WHERE user_id = ? AND kind = ? AND platform = ? AND model_id = ?')
    .run(userId, kind, platform, modelId);
}

export function upsertModelOverrides(
  db: Db,
  platform: string,
  modelId: string,
  patch: ModelOverridePatch,
): StoredOverrides {
  const userId = requireUserId();
  const cleaned = cleanPatch(patch);
  if (Object.keys(cleaned).length === 0) return {};
  const existing = db
    .prepare('SELECT overrides_json FROM model_overrides WHERE user_id = ? AND platform = ? AND model_id = ?')
    .get(userId, platform, modelId) as { overrides_json: string } | undefined;
  const merged: StoredOverrides = { ...parseOverrides(existing?.overrides_json), ...cleaned };
  db.prepare(`
    INSERT INTO model_overrides (user_id, platform, model_id, overrides_json, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, platform, model_id)
    DO UPDATE SET overrides_json = excluded.overrides_json, updated_at = excluded.updated_at
  `).run(userId, platform, modelId, JSON.stringify(merged));
  return merged;
}

export function getModelOverrides(
  db: Db,
  platform: string,
  modelId: string,
): StoredOverrides {
  const userId = requireUserId();
  const row = db
    .prepare('SELECT overrides_json FROM model_overrides WHERE user_id = ? AND platform = ? AND model_id = ?')
    .get(userId, platform, modelId) as { overrides_json: string } | undefined;
  return parseOverrides(row?.overrides_json);
}

export function applyModelOverrides(
  db: Db,
  platform: string,
  modelId: string,
): boolean {
  const overrides = getModelOverrides(db, platform, modelId);
  const keys = Object.keys(overrides) as Array<keyof ModelOverridePatch>;
  if (keys.length === 0) return false;

  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const key of keys) {
    assignments.push(`${OVERRIDE_COLUMNS[key]} = ?`);
    values.push(toDbValue(key, overrides[key]));
  }
  values.push(platform, modelId);
  db.prepare(`UPDATE models SET ${assignments.join(', ')} WHERE platform = ? AND model_id = ?`).run(...values);
  return true;
}

export function applyAllModelOverrides(db: Db): number {
  const userId = getCurrentUserId();
  let applied = 0;
  if (userId != null) {
    const rows = db.prepare('SELECT platform, model_id FROM model_overrides WHERE user_id = ?')
      .all(userId) as { platform: string; model_id: string }[];
    for (const row of rows) {
      if (applyModelOverrides(db, row.platform, row.model_id)) applied++;
    }
    return applied;
  }
  // Catalog sync (no ALS): apply each owner's overrides under their context.
  const owners = db.prepare('SELECT DISTINCT user_id FROM model_overrides').all() as { user_id: number }[];
  for (const owner of owners) {
    runWithUser(owner.user_id, () => {
      const owned = db.prepare('SELECT platform, model_id FROM model_overrides WHERE user_id = ?')
        .all(owner.user_id) as { platform: string; model_id: string }[];
      for (const row of owned) {
        if (applyModelOverrides(db, row.platform, row.model_id)) applied++;
      }
    });
  }
  return applied;
}

export function deleteTombstonedCatalogModels(db: Db): number {
  const userId = getCurrentUserId();
  // Per-user tombstones must not delete shared catalog rows for everyone.
  // When bound to a user, drop that user's fallback entries for tombstoned models.
  if (userId == null) return 0;

  const chatRows = db.prepare(`
    SELECT m.id, m.platform, m.model_id
      FROM models m
      JOIN catalog_model_tombstones t
        ON t.user_id = ? AND t.kind = 'chat' AND t.platform = m.platform AND t.model_id = m.model_id
     WHERE m.platform != 'custom' AND m.key_id IS NULL
  `).all(userId) as { id: number; platform: string; model_id: string }[];
  const mediaRows = db.prepare(`
    SELECT mm.id
      FROM media_models mm
      JOIN catalog_model_tombstones t
        ON t.user_id = ? AND t.kind = 'media' AND t.platform = mm.platform AND t.model_id = mm.model_id
  `).all(userId) as { id: number }[];

  const deleteChatFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ? AND user_id = ?');
  for (const row of chatRows) {
    deleteChatFallback.run(row.id, userId);
  }

  // Media rows stay in the shared table; listing filters tombstones per user.
  return chatRows.length + mediaRows.length;
}
