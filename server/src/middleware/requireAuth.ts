import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth.js';
import { runWithUser } from '../lib/request-context.js';

// Gate the /api/* admin surface behind a dashboard session.
// The token is the opaque session token issued by /api/auth/login|setup|register,
// sent as `Authorization: Bearer <token>`. The /v1 proxy is NOT gated by this —
// it uses per-user unified API key auth for app clients.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  (req as Request & { user?: typeof session }).user = session;
  runWithUser(session.userId, () => next());
}

/** Require the authenticated dashboard user to be an admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { isAdmin?: boolean } }).user;
  if (!user?.isAdmin) {
    res.status(403).json({ error: { message: 'Admin access required', type: 'forbidden' } });
    return;
  }
  next();
}
