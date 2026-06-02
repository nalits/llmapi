import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'

interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
  supportsVision: boolean
  keyCount: number
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: { displayName: string; platform: string; budget: number }[]
}

const platformColors: Record<string, string> = {
  google:      '#4285f4',
  groq:        '#f55036',
  cerebras:    '#8b5cf6',
  sambanova:   '#14b8a6',
  nvidia:      '#76b900',
  mistral:     '#f59e0b',
  openrouter:  '#ec4899',
  github:      '#6e7b8b',
  cohere:      '#d946ef',
  cloudflare:  '#f38020',
  zhipu:       '#06b6d4',
  ollama:      '#000000',
  kilo:        '#7c3aed',
  pollinations: '#a855f7',
  llm7:        '#0ea5e9',
  huggingface: '#ff9d00',
}

function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0

  // Scale each model's segment proportionally so the colored portion of the
  // bar sums to `remaining`; the grey tail represents what's been used.
  const modelsWithWidth = models.map(m => ({
    ...m,
    remainingTokens: totalBudget > 0 ? (m.budget / totalBudget) * remaining : 0,
    widthPct: totalBudget > 0 ? (m.budget / totalBudget) * (remaining / totalBudget) * 100 : 0,
  }))
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-medium">Monthly token budget</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">{formatTokens(remaining)}</span> remaining
          <span className="mx-1.5">·</span>
          {remainingPct}% of {formatTokens(totalBudget)}
        </span>
      </div>

      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {modelsWithWidth.map((m, i) => (
          <div
            key={i}
            title={`${m.displayName} (${m.platform}) — ${formatTokens(m.remainingTokens)} remaining`}
            style={{
              width: `${m.widthPct}%`,
              backgroundColor: platformColors[m.platform] ?? '#94a3b8',
            }}
          />
        ))}
        {totalUsed > 0 && (
          <div
            title={`Used — ${formatTokens(totalUsed)}`}
            className="bg-muted-foreground/30"
            style={{ width: `${usedPct}%` }}
          />
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
        {modelsWithWidth.map((m, i) => (
          <div key={i} className="flex items-center gap-2 min-w-0">
            <span
              className="size-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
            />
            <span className="truncate">{m.displayName}</span>
            <span className="flex-1" />
            <span className="font-mono text-muted-foreground">{formatTokens(m.remainingTokens)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Bandit routing strategy ─────────────────────────────────────────────────
type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable'

interface RoutingScore {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  reliability: number
  speed: number
  intelligence: number
  headroom: number
  rateLimit: number
  score: number
  totalRequests: number
}

interface RoutingData {
  strategy: RoutingStrategy
  weights: { reliability: number; speed: number; intelligence: number } | null
  scores: RoutingScore[]
}

const STRATEGIES: { key: RoutingStrategy; label: string; blurb: string }[] = [
  { key: 'priority', label: 'Manual', blurb: 'Use the hand-ordered chain below (no scoring).' },
  { key: 'balanced', label: 'Balanced', blurb: 'Reliability leads; speed and intelligence split the rest.' },
  { key: 'smartest', label: 'Smartest', blurb: 'Prefer the most capable model that still works.' },
  { key: 'fastest', label: 'Fastest', blurb: 'Prefer the fastest model that still works.' },
  { key: 'reliable', label: 'Most reliable', blurb: 'Maximize success rate above all.' },
]

// A 0..1 value as a thin horizontal bar with the number beside it.
function AxisBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.round(value * 100)}%`, backgroundColor: color }} />
      </div>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums w-7 text-right">
        {Math.round(value * 100)}
      </span>
    </div>
  )
}

function RoutingPanel({
  data,
  onSelect,
  pending,
}: {
  data: RoutingData
  onSelect: (s: RoutingStrategy) => void
  pending: boolean
}) {
  const active = STRATEGIES.find(s => s.key === data.strategy) ?? STRATEGIES[0]
  const banditOn = data.strategy !== 'priority'
  // Only show models that have been observed or are enabled, ranked by score.
  const rows = data.scores.filter(s => s.enabled || s.totalRequests > 0)

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-sm font-medium">Routing strategy</h2>
        <span className="text-xs text-muted-foreground">{active.blurb}</span>
      </div>

      <div className="mt-3 inline-flex flex-wrap gap-1 rounded-lg border p-1">
        {STRATEGIES.map(s => (
          <button
            key={s.key}
            disabled={pending}
            onClick={() => onSelect(s.key)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
              s.key === data.strategy
                ? 'bg-foreground text-background font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {data.weights && (
        <p className="mt-2 text-xs text-muted-foreground tabular-nums">
          Weights — reliability {Math.round(data.weights.reliability * 100)}% ·
          {' '}speed {Math.round(data.weights.speed * 100)}% ·
          {' '}intelligence {Math.round(data.weights.intelligence * 100)}%
        </p>
      )}

      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1.5 pr-3 font-medium">{banditOn ? '#' : ''}</th>
                <th className="py-1.5 pr-3 font-medium">Model</th>
                <th className="py-1.5 pr-3 font-medium">Reliability</th>
                <th className="py-1.5 pr-3 font-medium">Speed</th>
                <th className="py-1.5 pr-3 font-medium">Intelligence</th>
                <th className="py-1.5 pr-3 font-medium" title="Free-quota headroom × rate-limit guardrails">Guardrails</th>
                <th className="py-1.5 pr-3 font-medium text-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.modelDbId} className={`border-b last:border-0 ${r.enabled ? '' : 'opacity-40'}`}>
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground tabular-nums">{banditOn ? i + 1 : '·'}</td>
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{r.displayName}</span>
                    <span className="ml-1.5 text-muted-foreground">{r.platform}</span>
                    {r.totalRequests > 0 && (
                      <span className="ml-1.5 text-muted-foreground/70">({r.totalRequests} obs)</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3"><AxisBar value={r.reliability} color="#22c55e" /></td>
                  <td className="py-1.5 pr-3"><AxisBar value={r.speed} color="#3b82f6" /></td>
                  <td className="py-1.5 pr-3"><AxisBar value={r.intelligence} color="#a855f7" /></td>
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground tabular-nums">
                    {(r.headroom * r.rateLimit) < 0.999
                      ? `×${(r.headroom * r.rateLimit).toFixed(2)}`
                      : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono font-medium tabular-nums">
                    {r.score.toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!banditOn && (
            <p className="mt-2 text-xs text-muted-foreground">
              Preview only — manual order (below) is active. Pick a strategy above to route by these scores.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function SortableModelRow({
  entry,
  index,
  onToggle,
}: {
  entry: FallbackEntry
  index: number
  onToggle: (modelDbId: number, enabled: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.modelDbId,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-3 px-4 py-3 bg-card ${isDragging ? 'opacity-50' : ''} ${entry.enabled ? '' : 'opacity-50'}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
        aria-label="Drag to reorder"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>
      <span className="text-xs font-mono text-muted-foreground w-5 tabular-nums">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{entry.displayName}</span>
          <span className="text-xs text-muted-foreground">{entry.platform}</span>
          {entry.supportsVision && (
            <span
              title="Accepts image input"
              className="text-xs rounded-full px-2 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400"
            >
              Vision
            </span>
          )}
          {entry.penalty > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              −{entry.penalty} penalty
            </span>
          )}
        </div>
        <div className="flex gap-3 mt-0.5 text-xs text-muted-foreground tabular-nums">
          <span>Intel #{entry.intelligenceRank}</span>
          <span>Speed #{entry.speedRank}</span>
          {entry.rpmLimit && <span>{entry.rpmLimit} rpm</span>}
          {entry.rpdLimit && <span>{entry.rpdLimit} rpd</span>}
          <span>{entry.monthlyTokenBudget} tok/mo</span>
        </div>
      </div>
      <Switch
        checked={entry.enabled}
        onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)}
      />
    </div>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
  })

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setLocalEntries(null)
    },
  })

  const sortMutation = useMutation({
    mutationFn: (preset: string) =>
      apiFetch(`/api/fallback/sort/${preset}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setLocalEntries(null)
    },
  })

  // Bandit routing: live per-model scores refresh on a short interval so the
  // table reflects recent traffic without a manual reload.
  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
    refetchInterval: 15_000,
  })

  const strategyMutation = useMutation({
    mutationFn: (strategy: RoutingStrategy) =>
      apiFetch('/api/fallback/routing', { method: 'PUT', body: JSON.stringify({ strategy }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
    },
  })

  const allEntries = localEntries ?? entries
  const displayEntries = allEntries.filter(e => e.keyCount > 0)
  const unconfiguredPlatforms = [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))]

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = displayEntries.findIndex(e => e.modelDbId === active.id)
    const newIndex = displayEntries.findIndex(e => e.modelDbId === over.id)
    const reorderedVisible = arrayMove(displayEntries, oldIndex, newIndex)
    const unconfigured = allEntries.filter(e => e.keyCount === 0)
    const merged = [
      ...reorderedVisible.map((e, i) => ({ ...e, priority: i + 1 })),
      ...unconfigured.map((e, i) => ({ ...e, priority: reorderedVisible.length + i + 1 })),
    ]
    setLocalEntries(merged)
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    const updated = allEntries.map(e =>
      e.modelDbId === modelDbId ? { ...e, enabled } : e
    )
    setLocalEntries(updated)
  }

  function handleSave() {
    if (!localEntries) return
    saveMutation.mutate(
      allEntries.map(e => ({
        modelDbId: e.modelDbId,
        priority: e.priority,
        enabled: e.enabled,
      }))
    )
  }

  const hasChanges = localEntries !== null

  return (
    <div>
      <PageHeader
        title="Fallback chain"
        description="Drag to reorder. Requests try models top-to-bottom until one succeeds."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => sortMutation.mutate('intelligence')} disabled={sortMutation.isPending}>
              Sort by intelligence
            </Button>
            <Button variant="outline" size="sm" onClick={() => sortMutation.mutate('speed')} disabled={sortMutation.isPending}>
              Sort by speed
            </Button>
            <Button variant="outline" size="sm" onClick={() => sortMutation.mutate('budget')} disabled={sortMutation.isPending}>
              Sort by budget
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        {routing && (
          <RoutingPanel
            data={routing}
            onSelect={(s) => strategyMutation.mutate(s)}
            pending={strategyMutation.isPending}
          />
        )}

        {tokenUsage && tokenUsage.totalBudget > 0 && (
          <TokenUsageBar data={tokenUsage} />
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : displayEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No models available. Add API keys on the <a href="/keys" className="underline text-foreground">Keys page</a> first.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border divide-y overflow-hidden">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={displayEntries.map(e => e.modelDbId)}
                  strategy={verticalListSortingStrategy}
                >
                  {displayEntries.map((entry, index) => (
                    <SortableModelRow
                      key={entry.modelDbId}
                      entry={entry}
                      index={index}
                      onToggle={handleToggle}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </div>

            {hasChanges && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setLocalEntries(null)}>
                  Discard
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'Saving…' : 'Save order'}
                </Button>
              </div>
            )}

            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Hidden (no keys): {unconfiguredPlatforms.join(', ')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
