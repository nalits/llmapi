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
  updateEmail,
  updatePassword,
  resetUserPassword,
  normalizeEmail,
} from '../services/auth.js';
import { setupCodeMatches, clearSetupCode, getSetupCode } from '../lib/setup-code.js';
import { generateResetCode, resetCodeMatches, clearResetCode } from '../lib/reset-code.js';
import { getDb } from '../db/index.js';

export const authRouter = Router();

const failedPasswordAttempts = new Map<number, number>();
let resetTargetEmail: string | null = null;

// Dashboard auth. These routes are mounted BEFORE requireAuth, so
// /status, /setup, /register and /login are reachable without a session;
// /logout and /me validate the token themselves.

const signupSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const registerSchema = signupSchema.extend({
  setupCode: z.string().min(1).optional(),
  inviteCode: z.string().min(1).optional(),
}).refine(d => !!(d.setupCode?.trim() || d.inviteCode?.trim()), {
  message: 'Setup code is required',
  path: ['setupCode'],
});

// Logging in is a lookup, not a registration. The desktop app seeds
// `desktop@localhost`, which has no TLD and must still be able to sign in.
const loginSchema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

// ── Brute-force throttle ──────────────────────────────────────────────────
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_TRACKED_EMAILS = 10_000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

function throttleKey(email: string): string {
  return normalizeEmail(email);
}
function isLockedOut(email: string): boolean {
  const a = attempts.get(throttleKey(email));
  return !!a && a.lockedUntil > Date.now();
}
function recordFailure(email: string): void {
  const key = throttleKey(email);
  const a = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(key, a);
  if (attempts.size > MAX_TRACKED_EMAILS) {
    const now = Date.now();
    for (const [tracked, state] of attempts) {
      if (tracked !== key && state.lockedUntil <= now) attempts.delete(tracked);
    }
  }
}
function clearFailures(email: string): void {
  attempts.delete(throttleKey(email));
}

function bearer(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
}

function isLoopbackAddress(value: string | undefined): boolean {
  let addr = (value ?? '').trim();
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

function isLoopbackRemote(req: Request): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const forwarded = req.headers['x-forwarded-for'];
  const firstForwarded = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(',')[0];
  return !firstForwarded || isLoopbackAddress(firstForwarded);
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
          'Check the server logs for the code, or open the dashboard from a browser on the machine running LLMAPI.',
        type: 'setup_code_required',
      },
    });
    return;
  }

  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  try {
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
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password } = parsed.data;

  if (isLockedOut(email)) {
    res.status(429).json({ error: { message: 'Too many attempts. Wait 15 minutes or restart the app.', type: 'rate_limit_error' } });
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

const changeEmailSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newEmail: z.string().email('A valid email is required'),
});

authRouter.post('/change-email', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  const parsed = changeEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  try {
    const ok = updateEmail(session.userId, parsed.data.currentPassword, parsed.data.newEmail);
    if (!ok) {
      const n = (failedPasswordAttempts.get(session.userId) || 0) + 1;
      if (n >= 3) {
        deleteSession(bearer(req));
        failedPasswordAttempts.delete(session.userId);
        res.status(401).json({ error: { message: 'Too many incorrect attempts. You have been signed out.', type: 'authentication_error' } });
        return;
      }
      failedPasswordAttempts.set(session.userId, n);
      res.status(403).json({ error: { message: 'Current password is incorrect', type: 'invalid_password' } });
      return;
    }
    failedPasswordAttempts.delete(session.userId);
    res.json({ success: true, email: parsed.data.newEmail.trim().toLowerCase() });
  } catch (err: any) {
    if (err.code === 'email_taken') {
      res.status(409).json({ error: { message: err.message, type: 'email_taken' } });
    } else {
      throw err;
    }
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

authRouter.post('/change-password', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const ok = updatePassword(session.userId, parsed.data.currentPassword, parsed.data.newPassword);
  if (!ok) {
    const n = (failedPasswordAttempts.get(session.userId) || 0) + 1;
    if (n >= 3) {
      deleteSession(bearer(req));
      failedPasswordAttempts.delete(session.userId);
      res.status(401).json({ error: { message: 'Too many incorrect attempts. You have been signed out.', type: 'authentication_error' } });
      return;
    }
    failedPasswordAttempts.set(session.userId, n);
    res.status(403).json({ error: { message: 'Current password is incorrect', type: 'invalid_password' } });
    return;
  }
  failedPasswordAttempts.delete(session.userId);
  res.json({ success: true });
});

const RESET_CODE_MIN_INTERVAL_MS = 10_000;
let lastResetCodeAt = 0;
const forgotPasswordSchema = z.object({
  email: z.string().min(1, 'Email is required'),
});

authRouter.post('/forgot-password', (req: Request, res: Response) => {
  if (userCount() === 0) {
    res.json({ success: true });
    return;
  }
  const now = Date.now();
  if (now - lastResetCodeAt < RESET_CODE_MIN_INTERVAL_MS) {
    res.status(429).json({ error: { message: 'Too many reset-code requests. Try again later.', type: 'rate_limit_error' } });
    return;
  }
  const parsed = forgotPasswordSchema.safeParse(req.body ?? {});
  if (parsed.success) {
    resetTargetEmail = normalizeEmail(parsed.data.email);
  } else if (userCount() === 1) {
    const row = getDb().prepare('SELECT email FROM users LIMIT 1').get() as { email: string } | undefined;
    resetTargetEmail = row?.email ?? null;
  } else {
    res.json({ success: true });
    return;
  }
  lastResetCodeAt = now;
  generateResetCode();
  res.json({ success: true });
});

const resetPasswordSchema = z.object({
  resetCode: z.string().min(1, 'Reset code is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  email: z.string().min(1).optional(),
});

authRouter.post('/reset-password', (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  if (!resetCodeMatches(parsed.data.resetCode)) {
    res.status(403).json({ error: { message: 'Invalid or expired reset code', type: 'authentication_error' } });
    return;
  }
  const email = parsed.data.email ? normalizeEmail(parsed.data.email) : resetTargetEmail;
  if (!email || !resetTargetEmail || resetTargetEmail !== email) {
    res.status(403).json({ error: { message: 'Invalid or expired reset code', type: 'authentication_error' } });
    return;
  }
  const ok = resetUserPassword(parsed.data.newPassword, email);
  if (!ok) {
    res.status(404).json({ error: { message: 'No account found', type: 'not_found' } });
    return;
  }
  clearResetCode();
  resetTargetEmail = null;
  res.json({ success: true });
});
