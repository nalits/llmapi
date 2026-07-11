import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

export function InviteCodeSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState(false)

  const me = useQuery<{ isAdmin?: boolean }>({
    queryKey: ['auth-me'],
    queryFn: () => apiFetch('/api/auth/me'),
  })

  const { data, isError, isFetching } = useQuery<{ inviteCode: string }>({
    queryKey: ['invite-code'],
    queryFn: () => apiFetch('/api/settings/invite-code'),
    enabled: !!me.data?.isAdmin,
    retry: false,
  })

  const rotate = useMutation({
    mutationFn: () => apiFetch<{ inviteCode: string }>('/api/settings/invite-code/rotate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invite-code'] }),
  })

  if (me.isLoading || !me.data?.isAdmin) return null

  const code = data?.inviteCode ?? ''

  function copy() {
    if (!code) return
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">{t('keys.inviteCode')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('keys.inviteCodeDesc')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => rotate.mutate()}
          disabled={rotate.isPending || isError || isFetching}
        >
          {t('keys.rotateInvite')}
        </Button>
      </div>

      {isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('keys.inviteLoadError')}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all tracking-widest">
            {code || '…'}
          </code>
          <Button variant="outline" size="sm" onClick={copy} disabled={!code}>
            {copied ? t('keys.copiedKey') : t('keys.copyKey')}
          </Button>
        </div>
      )}
    </section>
  )
}
