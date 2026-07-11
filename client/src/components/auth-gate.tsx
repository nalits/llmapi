import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, setToken, UNAUTHORIZED_EVENT, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isEmail } from '@/lib/validate'
import { useI18n } from '@/i18n'

// Matches the server rule (routes/auth.ts zod schema).
const PASSWORD_MIN = 8

interface AuthStatus {
  needsSetup: boolean
  needsInvite?: boolean
  authenticated: boolean
  email: string | null
  isAdmin?: boolean
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
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

  const isSetup = mode === 'setup'
  const isRegister = mode === 'register'
  const needsNewPassword = isSetup || isRegister
  const showSetupCode = isRegister || (isSetup && codeRequired)

  const emailError = !email.trim()
    ? t('validation.required')
    : !isEmail(email)
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

  return (
    <Centered>
      <div className="mb-6 flex items-center gap-2">
        <span className="inline-block size-2 rounded-full bg-foreground" />
        <span className="font-semibold tracking-tight text-sm">FreeLLMAPI</span>
      </div>
      <div className="rounded-3xl border bg-card p-6">
        <h1 className="text-base font-medium">{title}</h1>
        <p className="text-xs text-muted-foreground mt-1 mb-4">{description}</p>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="auth-email">{t('auth.email')}</Label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              aria-invalid={attempted && !!emailError}
            />
            {attempted && <FieldError error={emailError} />}
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
              aria-invalid={attempted && !!passwordError}
            />
            {attempted && <FieldError error={passwordError} />}
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
              />
              {attempted && <FieldError error={setupCodeError} />}
              <p className="text-xs text-muted-foreground">
                {isRegister ? t('auth.registerSetupCodeHint') : t('auth.setupCodeHint')}
              </p>
            </div>
          )}
          {error && <p className="text-destructive text-xs">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {submitLabel}
          </Button>
        </form>
        {!isSetup && onSwitchMode && !(typeof window !== 'undefined' && (window as any).__FREEAPI_DESKTOP__) && (
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
      </div>
    </Centered>
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

  function onAuthed() {
    queryClient.invalidateQueries()
    refetch()
  }

  if (isLoading) return <Centered><p className="text-sm text-muted-foreground text-center">{t('auth.loading')}</p></Centered>
  if (isError || !data) {
    return (
      <Centered>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('auth.serverUnreachableBefore')}<code className="font-mono">npm run dev</code>{t('auth.serverUnreachableAfter')}
        </div>
      </Centered>
    )
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
