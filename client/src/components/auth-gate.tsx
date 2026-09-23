import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { apiFetch, setToken, UNAUTHORIZED_EVENT, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isEmail } from '@/lib/validate'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'

// Matches the server rule (routes/auth.ts zod schema).
const PASSWORD_MIN = 8

// Inside the desktop shell the dashboard runs as a hidden machine account with
// a random password nobody knows (desktop/src/server-host.ts). There are no
// credentials to type, so the gate never shows a login form there: when the
// seeded session is gone (expired after a month of uptime, or cleared by a
// 401) it asks the shell for a fresh one through the preload bridge.
type DesktopWindow = Window & {
  __FREEAPI_DESKTOP__?: boolean
  __FREEAPI_SESSION__?: () => Promise<string>
}
function desktopSessionBridge(): (() => Promise<string>) | null {
  if (typeof window === 'undefined') return null
  const w = window as DesktopWindow
  return w.__FREEAPI_DESKTOP__ === true && typeof w.__FREEAPI_SESSION__ === 'function'
    ? w.__FREEAPI_SESSION__
    : null
}

interface AuthStatus {
  needsSetup: boolean
  needsInvite?: boolean
  authenticated: boolean
  email: string | null
  isAdmin?: boolean
}

function Centered({ children }: { children: ReactNode }) {
  // dvh, not vh: on mobile the collapsing URL bar and the software keyboard both
  // change the viewport, and 100vh leaves the card parked mid-scroll.
  return (
    <main className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}

type AuthMode = 'setup' | 'login' | 'register'

function AuthForm({ mode, onAuthed, onSwitchMode }: {
  mode: AuthMode
  onAuthed: () => void
  onSwitchMode?: (mode: 'login' | 'register') => void
}) {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [setupCode, setSetupCode] = useState('')
  // Revealed only after the server asks for it (remote first-run setup).
  // Register always requires the setup code.
  const [codeRequired, setCodeRequired] = useState(mode === 'register')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [showForgot, setShowForgot] = useState(false)

  const isSetup = mode === 'setup'
  const isRegister = mode === 'register'
  const needsNewPassword = isSetup || isRegister
  const showSetupCode = isRegister || (isSetup && codeRequired)

  // Inline field feedback; the server stays authoritative. Only setup/register
  // enforce the password minimum client-side. Login accepts desktop@localhost.
  const emailError = !email.trim()
    ? t('validation.required')
    : isSetup && !isEmail(email)
      ? t('validation.email')
      : null
  const passwordError = !password
    ? t('validation.required')
    : needsNewPassword && password.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : null
  const setupCodeError = showSetupCode && !setupCode.trim()
    ? t('validation.required')
    : null

  const showEmailError = attempted && !!emailError
  const showPasswordError = attempted && !!passwordError

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (emailError || passwordError || setupCodeError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload: Record<string, string> = { email, password }
      if (showSetupCode && setupCode) payload.setupCode = setupCode.trim()
      const path = isSetup
        ? '/api/auth/setup'
        : isRegister
          ? '/api/auth/register'
          : '/api/auth/login'
      const res = await apiFetch<{ token: string }>(path, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setToken(res.token)
      onAuthed()
    } catch (err) {
      if (isSetup && (err as ApiError).code === 'setup_code_required') {
        setCodeRequired(true)
      }
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const title = isSetup
    ? t('auth.createYourAccount')
    : isRegister
      ? t('auth.createAccountWithInvite')
      : t('auth.signIn')
  const description = isSetup
    ? t('auth.setupDescription')
    : isRegister
      ? t('auth.registerDescription')
      : t('auth.loginDescription')
  const submitLabel = busy
    ? (needsNewPassword ? t('auth.creating') : t('auth.signingIn'))
    : (needsNewPassword ? t('auth.createAccount') : t('auth.signIn'))

  if (showForgot && !isSetup && !isRegister) {
    return <ForgotPasswordForm onBack={() => setShowForgot(false)} />
  }

  return (
    <Centered>
      <div className="mb-6 flex items-center gap-2">
        <span className="inline-block size-2 rounded-full bg-foreground" />
        <span className="font-semibold tracking-tight text-sm">LLMAPI</span>
      </div>
      <div className="rounded-3xl border bg-card p-6">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1.5 mb-6">{description}</p>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="auth-email">{t('auth.email')}</Label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="username"
              autoFocus
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              aria-invalid={showEmailError}
              aria-describedby={showEmailError ? 'auth-email-error' : undefined}
            />
            {attempted && <FieldError id="auth-email-error" error={emailError} />}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="auth-password">{t('auth.password')}</Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete={needsNewPassword ? 'new-password' : 'current-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={needsNewPassword ? t('auth.passwordPlaceholderSetup') : t('auth.passwordPlaceholderLogin')}
              aria-invalid={showPasswordError}
              aria-describedby={showPasswordError ? 'auth-password-error' : undefined}
            />
            {attempted && <FieldError id="auth-password-error" error={passwordError} />}
          </div>
          {showSetupCode && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="auth-setup-code">{t('auth.setupCode')}</Label>
              <Input
                id="auth-setup-code"
                type="text"
                autoComplete="off"
                value={setupCode}
                onChange={e => setSetupCode(e.target.value)}
                placeholder={t('auth.setupCodePlaceholder')}
                aria-invalid={attempted && !!setupCodeError}
                aria-describedby="auth-setup-code-hint"
              />
              {attempted && <FieldError error={setupCodeError} />}
              <p id="auth-setup-code-hint" className="text-xs text-muted-foreground">
                {isRegister ? t('auth.registerSetupCodeHint') : t('auth.setupCodeHint')}
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full h-10" disabled={busy}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {submitLabel}
          </Button>
        </form>
        {!isSetup && onSwitchMode && !(typeof window !== 'undefined' && (window as DesktopWindow).__FREEAPI_DESKTOP__) && (
          <p className="text-xs text-muted-foreground mt-4 text-center">
            {isRegister ? (
              <>
                {t('auth.haveAccount')}{' '}
                <button type="button" className="underline underline-offset-2" onClick={() => onSwitchMode('login')}>
                  {t('auth.signIn')}
                </button>
              </>
            ) : (
              <>
                {t('auth.needAccount')}{' '}
                <button type="button" className="underline underline-offset-2" onClick={() => onSwitchMode('register')}>
                  {t('auth.createAccount')}
                </button>
              </>
            )}
          </p>
        )}
        {!isSetup && !isRegister && (
          <button
            type="button"
            onClick={() => setShowForgot(true)}
            className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('auth.forgotPassword')}
          </button>
        )}
      </div>
    </Centered>
  )
}

// Forgot / Reset password flow

type ForgotStep = 'request' | 'reset' | 'done'

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [step, setStep] = useState<ForgotStep>('request')
  const [resetEmail, setResetEmail] = useState('')
  const [resetCode, setResetCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const passwordError = !newPassword
    ? t('validation.required')
    : newPassword.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : null
  const codeError = !resetCode.trim() ? t('validation.required') : null

  async function requestCode() {
    setBusy(true)
    setError('')
    try {
      await apiFetch('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: resetEmail.trim() }),
      })
      setStep('reset')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    if (codeError || passwordError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ resetCode: resetCode.trim(), newPassword, email: resetEmail.trim() }),
      })
      setStep('done')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <div className="mb-6 flex items-center gap-2">
        <span className="inline-block size-2 rounded-full bg-foreground" />
        <span className="font-semibold tracking-tight text-sm">LLMAPI</span>
      </div>
      <div className="rounded-3xl border bg-card p-6">
        <h1 className="text-base font-medium">{t('auth.forgotPassword')}</h1>

        {step === 'request' && (
          <div className="mt-1 space-y-3">
            <p className="text-xs text-muted-foreground mb-4">{t('auth.forgotPasswordDescription')}</p>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reset-email">{t('auth.email')}</Label>
              <Input
                id="reset-email"
                type="email"
                autoComplete="username"
                value={resetEmail}
                onChange={e => setResetEmail(e.target.value)}
                placeholder={t('auth.emailPlaceholder')}
              />
            </div>
            {error && <p className="text-destructive text-xs">{error}</p>}
            <Button className="w-full" disabled={busy} onClick={requestCode}>
              {busy ? t('auth.requestingResetCode') : t('auth.requestResetCode')}
            </Button>
          </div>
        )}

        {step === 'reset' && (
          <form onSubmit={submitReset} className="space-y-3 mt-4" noValidate>
            <p className="text-xs text-muted-foreground">{t('auth.resetCodeHint')}</p>
            <p className="text-xs text-muted-foreground">{t('auth.resetCodeDockerHint')}</p>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reset-code">{t('auth.resetCode')}</Label>
              <Input
                id="reset-code"
                type="text"
                autoComplete="off"
                value={resetCode}
                onChange={e => setResetCode(e.target.value)}
                placeholder={t('auth.resetCodePlaceholder')}
                aria-invalid={attempted && !!codeError}
              />
              {attempted && <FieldError error={codeError} />}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reset-new-password">{t('auth.newPassword')}</Label>
              <Input
                id="reset-new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder={t('auth.passwordPlaceholderSetup')}
                aria-invalid={attempted && !!passwordError}
              />
              {attempted && <FieldError error={passwordError} />}
            </div>
            {error && <p className="text-destructive text-xs">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? t('auth.resettingPassword') : t('auth.resetPassword')}
            </Button>
          </form>
        )}

        {step === 'done' && (
          <p className="text-xs text-muted-foreground mt-1 mb-4">{t('auth.passwordReset')}</p>
        )}

        <button
          type="button"
          onClick={onBack}
          className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('auth.backToLogin')}
        </button>
      </div>
    </Centered>
  )
}

// Change-credentials modal (rendered inside the authenticated shell)

interface ChangeCredentialsModalProps {
  mode: 'password' | 'email'
  onClose: () => void
}

export function ChangeCredentialsModal({ mode, onClose }: ChangeCredentialsModalProps) {
  const { t } = useI18n()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newValue, setNewValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const isPassword = mode === 'password'

  const newValueError = !newValue.trim()
    ? t('validation.required')
    : isPassword && newValue.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : !isPassword && !isEmail(newValue)
        ? t('validation.email')
        : null
  const currentPwError = !currentPassword ? t('validation.required') : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (newValueError || currentPwError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      if (isPassword) {
        await apiFetch('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword: newValue }),
        })
        toast.success(t('auth.passwordChanged'))
      } else {
        await apiFetch('/api/auth/change-email', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newEmail: newValue }),
        })
        toast.success(t('auth.emailChanged'))
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm rounded-3xl border bg-card p-6 shadow-xl">
        <h2 className="text-base font-medium mb-1">
          {isPassword ? t('auth.changePassword') : t('auth.changeEmail')}
        </h2>
        <form onSubmit={submit} className="space-y-3 mt-4" noValidate>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="cred-current-password">{t('auth.currentPassword')}</Label>
            <Input
              id="cred-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholderLogin')}
              aria-invalid={attempted && !!currentPwError}
            />
            {attempted && <FieldError error={currentPwError} />}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="cred-new-value">
              {isPassword ? t('auth.newPassword') : t('auth.newEmail')}
            </Label>
            <Input
              id="cred-new-value"
              type={isPassword ? 'password' : 'email'}
              autoComplete={isPassword ? 'new-password' : 'email'}
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder={isPassword ? t('auth.passwordPlaceholderSetup') : t('auth.emailPlaceholder')}
              aria-invalid={attempted && !!newValueError}
            />
            {attempted && <FieldError error={newValueError} />}
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" className="flex-1" disabled={busy}>
              {busy
                ? (isPassword ? t('auth.changingPassword') : t('auth.changingEmail'))
                : t('common.save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const { data, isLoading, isError, refetch } = useQuery<AuthStatus>({
    queryKey: ['auth-status'],
    queryFn: () => apiFetch('/api/auth/status'),
    retry: false,
  })

  useEffect(() => {
    const handler = () => { refetch() }
    window.addEventListener(UNAUTHORIZED_EVENT, handler)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler)
  }, [refetch])

  // Desktop self-repair: one attempt at a time, and none after the shell has
  // handed back a session the server still rejects — a broken install shows a
  // message instead of looping.
  const desktopSession = desktopSessionBridge()
  const desktopNeedsSession = !!desktopSession && !!data && (data.needsSetup || !data.authenticated)
  const repairing = useRef(false)
  const [repairFailed, setRepairFailed] = useState(false)
  useEffect(() => {
    if (!desktopNeedsSession || !desktopSession || repairing.current || repairFailed) return
    repairing.current = true
    ;(async () => {
      try {
        const token = await desktopSession()
        if (!token) throw new Error('empty session token')
        setToken(token)
        queryClient.invalidateQueries()
        const next = await refetch()
        if (!next.data?.authenticated) setRepairFailed(true)
      } catch (err) {
        console.error('[auth-gate] desktop session repair failed', err)
        setRepairFailed(true)
      } finally {
        repairing.current = false
      }
    })()
  }, [desktopNeedsSession, desktopSession, repairFailed, queryClient, refetch])

  function onAuthed() {
    queryClient.invalidateQueries()
    refetch()
  }

  if (isLoading) {
    return (
      <Centered>
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t('auth.loading')}
        </p>
      </Centered>
    )
  }
  if (isError || !data) {
    return (
      <Centered>
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('auth.serverUnreachableBefore')}<code className="font-mono">npm run dev</code>{t('auth.serverUnreachableAfter')}
        </div>
      </Centered>
    )
  }

  if (desktopNeedsSession) {
    if (repairFailed) {
      return (
        <Centered>
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
            {t('auth.desktopSessionFailed')}
          </div>
        </Centered>
      )
    }
    return <Centered><p className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" aria-hidden />{t('auth.loading')}</p></Centered>
  }
  if (data.needsSetup) return <AuthForm mode="setup" onAuthed={onAuthed} />
  if (!data.authenticated) {
    return (
      <AuthForm
        key={authMode}
        mode={authMode}
        onAuthed={onAuthed}
        onSwitchMode={setAuthMode}
      />
    )
  }

  return <>{children}</>
}

