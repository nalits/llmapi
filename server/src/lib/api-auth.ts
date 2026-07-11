import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { resolveUserFromApiKey } from '../db/index.js';
import { runWithUser } from './request-context.js';

export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers['x-api-key'];
  const xApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = xApiKey?.trim();
  return trimmed || undefined;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Authenticate a /v1 request with a per-user unified API key.
 * Returns null and sends 401 if authentication fails.
 */
export function authenticateUnifiedKey(req: Request, res: Response): { userId: number } | null {
  const token = extractApiToken(req);
  const resolved = resolveUserFromApiKey(token);
  if (!resolved || !token || !timingSafeStringEqual(token, resolved.key)) {
    // Anthropic clients expect the Anthropic error envelope on /v1/messages
    // (and whenever they send `anthropic-version`).
    const path = req.path || '';
    const url = req.originalUrl || '';
    const wantAnthropic = typeof req.headers['anthropic-version'] === 'string'
      || /\/messages(?:\/|$|\?)/.test(path)
      || /\/messages(?:\/|$|\?)/.test(url);
    if (wantAnthropic) {
      res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid API key' },
      });
    } else {
      res.status(401).json({
        error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' },
      });
    }
    return null;
  }
  return { userId: resolved.userId };
}

/** Express middleware: validate unified API key and bind user AsyncLocalStorage. */
export function requireUnifiedApiKey(req: Request, res: Response, next: NextFunction): void {
  const auth = authenticateUnifiedKey(req, res);
  if (!auth) return;
  runWithUser(auth.userId, () => next());
}
