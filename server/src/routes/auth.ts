import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  userCount,
  createUser,
  verifyCredentials,
  createSession,
  validateSession,
  deleteSession,
  inviteCodeMatches,
  ensureEnrollmentInviteCode,
  logEnrollmentSetupCode,
} from '../services/auth.js';
import { setupCodeMatches, clearSetupCode, getSetupCode } from '../lib/setup-code.js';

export const authRouter = Router();

// Dashboard auth. These routes are mounted BEFORE requireAuth, so
// /status, /setup, /register and /login are reachable without a session;
// /logout and /me validate the token themselves.

const credentialsSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// Prefer setupCode (same secret as first-run / server logs). inviteCode kept as alias.
const registerSchema = credentialsSchema.extend({
  setupCode: z.string().min(1).optional(),
  inviteCode: z.string().min(1).optional(),
}).refine(d => !!(d.setupCode?.trim() || d.inviteCode?.trim()), {
  message: 'Setup code is required',
  path: ['setupCode'],
});

// ── Brute-force throttle ──────────────────────────────────────────────────
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

function isLockedOut(email: string): boolean {
  const a = attempts.get(email.toLowerCase());
  return !!a && a.lockedUntil > Date.now();
}
function recordFailure(email: string): void {
  const key = email.toLowerCase();
  const a = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(key, a);
}
function clearFailures(email: string): void {
  attempts.delete(email.toLowerCase());
}

function bearer(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
}

function isLoopbackRemote(req: Request): boolean {
  let addr = req.socket.remoteAddress ?? '';
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

authRouter.get('/status', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  const count = userCount();
  res.json({
    needsSetup: count === 0,
    needsInvite: count > 0 && !session,
    authenticated: !!session,
    email: session?.email ?? null,
    isAdmin: session?.isAdmin ?? false,
  });
});

// First-run account creation. Only allowed while there are zero users.
authRouter.post('/setup', (req: Request, res: Response) => {
  if (userCount() > 0) {
    clearSetupCode();
    res.status(409).json({ error: { message: 'Setup already completed. Use login or register instead.', type: 'setup_complete' } });
    return;
  }

  if (!isLoopbackRemote(req) && !setupCodeMatches((req.body ?? {}).setupCode)) {
    res.status(403).json({
      error: {
        message: 'A setup code is required to create the first account from a remote device. ' +
          'Check the server logs for the code, or open the dashboard from a browser on the machine running FreeLLMAPI.',
        type: 'setup_code_required',
      },
    });
    return;
  }

  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  try {
    // Keep the first-run setup code as the ongoing enrollment secret so the
    // same value from the server logs works for every later signup.
    ensureEnrollmentInviteCode(getSetupCode());
    clearSetupCode();
    const user = createUser(parsed.data.email, parsed.data.password, { isAdmin: true });
    logEnrollmentSetupCode();
    const token = createSession(user.userId);
    res.status(201).json({ token, email: user.email, isAdmin: user.isAdmin });
  } catch (err: any) {
    if (err?.code === 'email_taken') {
      res.status(409).json({ error: { message: err.message, type: 'email_taken' } });
      return;
    }
    throw err;
  }
});

// Setup-code-gated enrollment for additional users (same secret as first-run).
authRouter.post('/register', (req: Request, res: Response) => {
  if (userCount() === 0) {
    res.status(409).json({ error: { message: 'Server has no admin yet. Use setup instead.', type: 'setup_required' } });
    return;
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const code = (parsed.data.setupCode ?? parsed.data.inviteCode ?? '').trim();
  if (!inviteCodeMatches(code)) {
    res.status(403).json({
      error: {
        message: 'Invalid setup code. Check the server logs, or ask an admin (Keys → Setup code).',
        type: 'invalid_setup_code',
      },
    });
    return;
  }

  if (isLockedOut(parsed.data.email)) {
    res.status(429).json({ error: { message: 'Too many failed attempts. Try again later.', type: 'rate_limit_error' } });
    return;
  }

  try {
    const user = createUser(parsed.data.email, parsed.data.password, { isAdmin: false });
    const token = createSession(user.userId);
    res.status(201).json({ token, email: user.email, isAdmin: false });
  } catch (err: any) {
    if (err?.code === 'email_taken') {
      res.status(409).json({ error: { message: err.message, type: 'email_taken' } });
      return;
    }
    throw err;
  }
});

authRouter.post('/login', (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password } = parsed.data;

  if (isLockedOut(email)) {
    res.status(429).json({ error: { message: 'Too many failed attempts. Try again later.', type: 'rate_limit_error' } });
    return;
  }

  const user = verifyCredentials(email, password);
  if (!user) {
    recordFailure(email);
    res.status(401).json({ error: { message: 'Invalid email or password', type: 'authentication_error' } });
    return;
  }

  clearFailures(email);
  const token = createSession(user.userId);
  res.json({ token, email: user.email, isAdmin: user.isAdmin });
});

authRouter.post('/logout', (req: Request, res: Response) => {
  deleteSession(bearer(req));
  res.json({ success: true });
});

authRouter.get('/me', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  res.json({ email: session.email, isAdmin: session.isAdmin, userId: session.userId });
});
