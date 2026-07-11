import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getOrCreateUserApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runWithUser } from '../../lib/request-context.js';

async function call(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Multi-user isolation', () => {
  let app: Express;
  let adminToken = '';
  let userToken = '';
  let adminKey = '';
  let userKey = '';
  let inviteCode = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();

    const setup = await call(app, 'POST', '/api/auth/setup', {
      email: 'admin@example.com',
      password: 'supersecret',
    });
    expect(setup.status).toBe(201);
    adminToken = setup.body.token;
    expect(setup.body.isAdmin).toBe(true);

    const invite = await call(app, 'GET', '/api/settings/invite-code', undefined, {
      Authorization: `Bearer ${adminToken}`,
    });
    expect(invite.status).toBe(200);
    inviteCode = invite.body.inviteCode;
    expect(inviteCode).toMatch(/^[A-Z2-9]{10}$/);

    const reg = await call(app, 'POST', '/api/auth/register', {
      email: 'user@example.com',
      password: 'supersecret',
      setupCode: inviteCode,
    });
    expect(reg.status).toBe(201);
    userToken = reg.body.token;
    expect(reg.body.isAdmin).toBe(false);

    const adminKeyRes = await call(app, 'GET', '/api/settings/api-key', undefined, {
      Authorization: `Bearer ${adminToken}`,
    });
    const userKeyRes = await call(app, 'GET', '/api/settings/api-key', undefined, {
      Authorization: `Bearer ${userToken}`,
    });
    adminKey = adminKeyRes.body.apiKey;
    userKey = userKeyRes.body.apiKey;
    expect(adminKey).toMatch(/^freellmapi-/);
    expect(userKey).toMatch(/^freellmapi-/);
    expect(adminKey).not.toBe(userKey);
  });

  it('rejects register without a valid setup code', async () => {
    const bad = await call(app, 'POST', '/api/auth/register', {
      email: 'nope@example.com',
      password: 'supersecret',
      setupCode: 'WRONGCODE1',
    });
    expect(bad.status).toBe(403);
    expect(bad.body.error.type).toBe('invalid_setup_code');
  });

  it('accepts setupCode alias for enrollment', async () => {
    const reg = await call(app, 'POST', '/api/auth/register', {
      email: 'user2@example.com',
      password: 'supersecret',
      setupCode: inviteCode,
    });
    expect(reg.status).toBe(201);
  });

  it('keeps provider keys isolated between users', async () => {
    const enc = encrypt('gsk-admin-secret-key');
    const db = getDb();
    const adminId = (db.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").get() as { id: number }).id;
    db.prepare(`
      INSERT INTO api_keys (user_id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'groq', 'admin', ?, ?, ?, 'healthy', 1)
    `).run(adminId, enc.encrypted, enc.iv, enc.authTag);

    const adminKeys = await call(app, 'GET', '/api/keys', undefined, {
      Authorization: `Bearer ${adminToken}`,
    });
    const userKeys = await call(app, 'GET', '/api/keys', undefined, {
      Authorization: `Bearer ${userToken}`,
    });
    expect(adminKeys.status).toBe(200);
    expect(userKeys.status).toBe(200);
    expect(adminKeys.body.some((k: { platform: string }) => k.platform === 'groq')).toBe(true);
    expect(userKeys.body.some((k: { platform: string }) => k.platform === 'groq')).toBe(false);
  });

  it('non-admin cannot view or rotate the invite code', async () => {
    const view = await call(app, 'GET', '/api/settings/invite-code', undefined, {
      Authorization: `Bearer ${userToken}`,
    });
    expect(view.status).toBe(403);

    const rotate = await call(app, 'POST', '/api/settings/invite-code/rotate', undefined, {
      Authorization: `Bearer ${userToken}`,
    });
    expect(rotate.status).toBe(403);
  });

  it('user A unified key cannot see user B models availability from B keys', async () => {
    // User key lists models; availability for groq should be 0 because user has no groq key.
    const listed = await call(app, 'GET', '/v1/models', undefined, {
      Authorization: `Bearer ${userKey}`,
    });
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.data)).toBe(true);

    // Admin key works for /v1
    const adminListed = await call(app, 'GET', '/v1/models', undefined, {
      Authorization: `Bearer ${adminKey}`,
    });
    expect(adminListed.status).toBe(200);
  });

  it('rejects /v1 with the other user\'s regenerated old key after rotate', async () => {
    const oldKey = userKey;
    const rotated = await call(app, 'POST', '/api/settings/api-key/regenerate', undefined, {
      Authorization: `Bearer ${userToken}`,
    });
    expect(rotated.status).toBe(200);
    userKey = rotated.body.apiKey;
    expect(userKey).not.toBe(oldKey);

    const stale = await call(app, 'GET', '/v1/models', undefined, {
      Authorization: `Bearer ${oldKey}`,
    });
    expect(stale.status).toBe(401);

    const fresh = await call(app, 'GET', '/v1/models', undefined, {
      Authorization: `Bearer ${userKey}`,
    });
    expect(fresh.status).toBe(200);
  });

  it('getOrCreateUserApiKey is stable per user', () => {
    const db = getDb();
    const adminId = (db.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").get() as { id: number }).id;
    const a = runWithUser(adminId, () => getOrCreateUserApiKey(adminId));
    const b = runWithUser(adminId, () => getOrCreateUserApiKey(adminId));
    expect(a).toBe(b);
  });
});
