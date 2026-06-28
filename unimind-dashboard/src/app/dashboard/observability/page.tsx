"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  GitCompareArrows,
  Loader2,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  excerpt,
  type ContradictionMemory,
  type ContradictionPair,
  type GapRecord,
  type SynthesisRun,
  type SynthesisRunResult,
} from "@/lib/observability"

type SynthesisOperation = "all" | "pattern" | "contradiction" | "gap" | "decay" | "validation"
type GapStateFilter = "all" | "open" | "closed"

interface MonitoringLatency {
  p50: number | null
  p95: number | null
  p99: number | null
  sampleSize: number
}

interface MonitoringReadSummary {
  latencyMs: MonitoringLatency
  hitRate: number
  averageBudgetUtilization: number
  utilizationP95: number | null
  backstopTripRate: number
  naiveFallbackRate: number
  sampleSize: number
}

interface MonitoringAlert {
  code: string
  severity: "warning" | "critical"
  title: string
  detail: string
  ts: string | null
}

interface MonitoringData {
  alerts: MonitoringAlert[]
  synthesis: {
    latestRunAt: string | null
    latestDurationMs: number | null
    latestStatus: string | null
    daily: Array<{
      date: string
      insightsCreated: number
      insightsUpdated: number
      contradictionsFlagged: number
      gapsCreated: number
      confidenceDecayed: number
      validationRejected: number
      runs: number
    }>
  }
  readPipeline: {
    inject: MonitoringReadSummary
    recall: MonitoringReadSummary
  }
  gaps: {
    total: number
    open: number
    closed: number
    closedLast7d: number
    daily: Array<{ date: string; opened: number; closed: number }>
  }
  targets: {
    synthesisMs: number
    recallMs: number
  }
}

const selectCls = "h-9 rounded-md border border-input bg-background px-3 text-sm"

function fmtDateTime(ts: string): string {
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return ts
  return new Date(ms).toLocaleString()
}

function fmtRelative(ts: string): string {
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return "unknown"
  const diff = Date.now() - ms
  const seconds = Math.max(1, Math.round(diff / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

function fmtDays(ts: string): string {
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return "unknown age"
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000))
  return days === 0 ? "today" : `${days}d`
}

function fmtDuration(durationMs: number | null): string {
  if (!durationMs || durationMs <= 0) return "n/a"
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${(durationMs / 60_000).toFixed(1)}m`
}

function fmtPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function resultBadge(runResult: SynthesisRunResult): string {
  switch (runResult) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/15 text-emerald-200"
    case "partial":
      return "border-amber-500/30 bg-amber-500/15 text-amber-100"
    default:
      return "border-rose-500/30 bg-rose-500/15 text-rose-200"
  }
}

function priorityBadge(priority: string): string {
  switch (priority) {
    case "critical":
      return "border-rose-500/30 bg-rose-500/15 text-rose-200"
    case "high":
      return "border-orange-500/30 bg-orange-500/15 text-orange-100"
    case "medium":
      return "border-sky-500/30 bg-sky-500/15 text-sky-100"
    default:
      return "border-muted bg-muted/50 text-muted-foreground"
  }
}

function matchesDate(run: SynthesisRun, dateFilter: string): boolean {
  if (!dateFilter) return true
  return run.ts.slice(0, 10) === dateFilter
}

function matchesOperation(run: SynthesisRun, operation: SynthesisOperation): boolean {
  if (operation === "all") return true
  if (operation === "pattern") return (run.details.patterns_found ?? 0) > 0 || run.details.phase_status?.pattern === "error"
  if (operation === "contradiction") return (run.details.contradictions_flagged ?? 0) > 0 || run.details.phase_status?.contradiction === "error"
  if (operation === "gap") return (run.details.gaps_created ?? 0) > 0 || run.details.phase_status?.gap === "error"
  if (operation === "decay") return (run.details.confidence_decayed ?? 0) > 0 || run.details.phase_status?.decay === "error"
  return (run.details.validation_rejected ?? 0) > 0
}

function matchesGapState(gap: GapRecord, state: GapStateFilter): boolean {
  if (state === "all") return true
  return gap.state === state
}

function MemoryPane({ memory }: { memory: ContradictionMemory }) {
  return (
    <div className="rounded-xl border border-border/50 bg-background/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">{memory.primaryType}</p>
          <p className="text-xs text-muted-foreground">{memory.kind ?? "raw memory"}</p>
        </div>
        <Badge variant="outline" className="border-border/60 bg-background/70">
          conf {memory.confidence.toFixed(2)}
        </Badge>
      </div>
      <p className="mt-4 text-sm leading-6 text-foreground">{memory.content}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{memory.memoryId}</span>
        <span>updated {fmtDateTime(memory.lastRevisedAt ?? memory.updatedAt)}</span>
      </div>
      <div className="mt-4">
        <Button asChild size="sm" variant="outline">
          <Link href={`/dashboard/graph?memoryId=${encodeURIComponent(memory.memoryId)}`}>
            View in graph
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  )
}

export default function ObservabilityPage() {
  const [synthesisRuns, setSynthesisRuns] = useState<SynthesisRun[]>([])
  const [gaps, setGaps] = useState<GapRecord[]>([])
  const [contradictions, setContradictions] = useState<ContradictionPair[]>([])
  const [monitoring, setMonitoring] = useState<MonitoringData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set())
  const [dateFilter, setDateFilter] = useState("")
  const [resultFilter, setResultFilter] = useState<"all" | SynthesisRunResult>("all")
  const [operationFilter, setOperationFilter] = useState<SynthesisOperation>("all")
  const [gapStateFilter, setGapStateFilter] = useState<GapStateFilter>("open")
  const [actionKey, setActionKey] = useState<string | null>(null)

  async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { cache: "no-store" })
    const data = await res.json()
    if (!res.ok || data.error) {
      throw new Error(data.error || `Request failed (${res.status})`)
    }
    return data as T
  }

  async function loadAll(initial = false) {
    if (initial) setLoading(true)
    else setRefreshing(true)

    try {
      setError(null)
      const [synthesisData, gapsData, contradictionsData, monitoringData] = await Promise.all([
        fetchJson<{ runs: SynthesisRun[] }>("/api/observability/synthesis"),
        fetchJson<{ gaps: GapRecord[] }>("/api/observability/gaps"),
        fetchJson<{ contradictions: ContradictionPair[] }>("/api/observability/contradictions"),
        fetchJson<MonitoringData>("/api/observability/monitoring"),
      ])

      setSynthesisRuns(synthesisData.runs ?? [])
      setGaps(gapsData.gaps ?? [])
      setContradictions(contradictionsData.contradictions ?? [])
      setMonitoring(monitoringData)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load observability data")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadAll(true)
  }, [])

  function toggleRun(runId: number) {
    setExpandedRuns((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  async function handleGapAction(memoryId: string, action: "close" | "reopen") {
    const key = `gap:${memoryId}:${action}`
    setActionKey(key)
    try {
      const res = await fetch("/api/observability/gaps", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryId, action }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`)
      const [refreshed, monitoringData] = await Promise.all([
        fetchJson<{ gaps: GapRecord[] }>("/api/observability/gaps"),
        fetchJson<MonitoringData>("/api/observability/monitoring"),
      ])
      setGaps(refreshed.gaps ?? [])
      setMonitoring(monitoringData)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update gap lifecycle")
    } finally {
      setActionKey(null)
    }
  }

  async function handleDismiss(pair: ContradictionPair) {
    const key = `contradiction:${pair.key}`
    setActionKey(key)
    try {
      const res = await fetch("/api/observability/contradictions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leftMemoryId: pair.left.memoryId,
          rightMemoryId: pair.right.memoryId,
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`)
      const [refreshed, monitoringData] = await Promise.all([
        fetchJson<{ contradictions: ContradictionPair[] }>("/api/observability/contradictions"),
        fetchJson<MonitoringData>("/api/observability/monitoring"),
      ])
      setContradictions(refreshed.contradictions ?? [])
      setMonitoring(monitoringData)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss contradiction")
    } finally {
      setActionKey(null)
    }
  }

  const filteredRuns = synthesisRuns.filter((run) =>
    matchesDate(run, dateFilter) &&
    (resultFilter === "all" || run.result === resultFilter) &&
    matchesOperation(run, operationFilter),
  )

  const visibleGaps = gaps.filter((gap) => matchesGapState(gap, gapStateFilter))
  const openGapCount = gaps.filter((gap) => gap.state === "open").length
  const latestRun = synthesisRuns[0]
  const activeAlerts = monitoring?.alerts ?? []

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>Observability</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6 pt-0">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl border border-primary/20 bg-primary/10 p-3">
                  <Activity className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight">Memory Intelligence Observability</h1>
                  <p className="text-sm text-muted-foreground">
                    Watch synthesis runs, manage open knowledge gaps, and review contradiction flags without introducing new stores.
                  </p>
                </div>
              </div>
              {error && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>
            <Button variant="outline" onClick={() => void loadAll()} disabled={refreshing || loading}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh observability
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardDescription>Synthesis sweeps</CardDescription>
                <CardTitle className="text-3xl">{synthesisRuns.length}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 text-sm text-muted-foreground">
                Daily audit runs flowing from `CRON/synthesis`.
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardDescription>Open gaps</CardDescription>
                <CardTitle className="text-3xl">{openGapCount}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 text-sm text-muted-foreground">
                Active `knowledge_gap` memories still awaiting a durable stance.
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardDescription>Flagged contradictions</CardDescription>
                <CardTitle className="text-3xl">{contradictions.length}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 text-sm text-muted-foreground">
                Neutral pairs backed by both node flags and `CONTRADICTS` edges.
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardDescription>Latest sweep</CardDescription>
                <CardTitle className="text-3xl capitalize">{latestRun?.result ?? "n/a"}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 text-sm text-muted-foreground">
                {latestRun ? `${fmtRelative(latestRun.ts)} · ${fmtDuration(latestRun.durationMs)}` : "No synthesis rows yet."}
              </CardContent>
            </Card>
          </div>

          <Card className="border-border/50">
            <CardHeader className="gap-3">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-2xl">
                    <AlertTriangle className="h-5 w-5 text-primary" />
                    Monitoring
                  </CardTitle>
                  <CardDescription>
                    Alerting, latency percentiles, budget utilization, and gap-closure trends sourced from audit rows plus current gap memories.
                  </CardDescription>
                </div>
                <Badge variant="outline" className="border-border/60 bg-background/60">
                  {activeAlerts.length} active alert{activeAlerts.length === 1 ? "" : "s"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {loading ? (
                <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-background/40 px-4 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading monitoring summary...
                </div>
              ) : monitoring ? (
                <>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {activeAlerts.length === 0 ? (
                      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-4 text-sm text-emerald-100">
                        <div className="flex items-center gap-2 font-medium">
                          <CheckCircle2 className="h-4 w-4" />
                          No active synthesis alerts
                        </div>
                        <p className="mt-2 text-emerald-50/80">
                          No overrun, contradiction-spike, or validation-spike conditions are currently firing.
                        </p>
                      </div>
                    ) : (
                      activeAlerts.map((alert) => (
                        <div
                          key={alert.code}
                          className={`rounded-xl border px-4 py-4 text-sm ${
                            alert.severity === "critical"
                              ? "border-rose-500/25 bg-rose-500/10 text-rose-100"
                              : "border-amber-500/25 bg-amber-500/10 text-amber-100"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-medium">{alert.title}</p>
                            <Badge variant="outline" className="border-current/30 bg-background/30 capitalize">
                              {alert.severity}
                            </Badge>
                          </div>
                          <p className="mt-2">{alert.detail}</p>
                          {alert.ts && <p className="mt-2 text-xs opacity-80">{fmtDateTime(alert.ts)}</p>}
                        </div>
                      ))
                    )}
                  </div>

                  <div className="grid gap-4 xl:grid-cols-3">
                    <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                      <p className="text-sm font-medium text-foreground">Synthesis health</p>
                      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                        <div className="flex items-center justify-between gap-3">
                          <span>Latest run</span>
                          <span className="text-foreground">{monitoring.synthesis.latestRunAt ? fmtDateTime(monitoring.synthesis.latestRunAt) : "n/a"}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Duration</span>
                          <span className="text-foreground">{fmtDuration(monitoring.synthesis.latestDurationMs)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Target</span>
                          <span className="text-foreground">{`< ${fmtDuration(monitoring.targets.synthesisMs)}`}</span>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                      <p className="text-sm font-medium text-foreground">Inject path</p>
                      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                        <div className="flex items-center justify-between gap-3">
                          <span>Latency p95</span>
                          <span className="text-foreground">{fmtDuration(monitoring.readPipeline.inject.latencyMs.p95)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Hit rate</span>
                          <span className="text-foreground">{fmtPercent(monitoring.readPipeline.inject.hitRate)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Backstop trips</span>
                          <span className="text-foreground">{fmtPercent(monitoring.readPipeline.inject.backstopTripRate)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Naive fallback</span>
                          <span className="text-foreground">{fmtPercent(monitoring.readPipeline.inject.naiveFallbackRate)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                      <p className="text-sm font-medium text-foreground">Recall path</p>
                      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                        <div className="flex items-center justify-between gap-3">
                          <span>Latency p95</span>
                          <span className="text-foreground">{fmtDuration(monitoring.readPipeline.recall.latencyMs.p95)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Hit rate</span>
                          <span className="text-foreground">{fmtPercent(monitoring.readPipeline.recall.hitRate)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Budget util avg</span>
                          <span className="text-foreground">{fmtPercent(monitoring.readPipeline.recall.averageBudgetUtilization)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>P95 util</span>
                          <span className="text-foreground">{monitoring.readPipeline.recall.utilizationP95 == null ? "n/a" : fmtPercent(monitoring.readPipeline.recall.utilizationP95)}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                    <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                      <p className="text-sm font-medium text-foreground">Daily synthesis report</p>
                      <div className="mt-3 space-y-2">
                        {monitoring.synthesis.daily.map((day) => (
                          <div key={day.date} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/55 px-3 py-2 text-xs">
                            <span className="font-medium text-foreground">{day.date}</span>
                            <span className="text-muted-foreground">created {day.insightsCreated}</span>
                            <span className="text-muted-foreground">updated {day.insightsUpdated}</span>
                            <span className="text-muted-foreground">contradictions {day.contradictionsFlagged}</span>
                            <span className="text-muted-foreground">gaps {day.gapsCreated}</span>
                            <span className="text-muted-foreground">rejected {day.validationRejected}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                      <p className="text-sm font-medium text-foreground">Gap closure trend</p>
                      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                        <div className="flex items-center justify-between gap-3">
                          <span>Open now</span>
                          <span className="text-foreground">{monitoring.gaps.open}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Closed now</span>
                          <span className="text-foreground">{monitoring.gaps.closed}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Closed in last 7d</span>
                          <span className="text-foreground">{monitoring.gaps.closedLast7d}</span>
                        </div>
                      </div>
                      <div className="mt-4 space-y-2">
                        {monitoring.gaps.daily.map((day) => (
                          <div key={day.date} className="flex items-center justify-between rounded-lg border border-border/40 bg-background/55 px-3 py-2 text-xs">
                            <span className="font-medium text-foreground">{day.date}</span>
                            <span className="text-muted-foreground">opened {day.opened}</span>
                            <span className="text-muted-foreground">closed {day.closed}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="gap-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-2xl">
                    <Sparkles className="h-5 w-5 text-primary" />
                    Synthesis Audit
                  </CardTitle>
                  <CardDescription>
                    Chronological synthesis sweeps with per-phase counts, partial failure visibility, and direct insight links.
                  </CardDescription>
                </div>
                <Badge variant="outline" className="border-border/60 bg-background/60">
                  {filteredRuns.length} visible run{filteredRuns.length === 1 ? "" : "s"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  value={dateFilter}
                  onChange={(event) => setDateFilter(event.target.value)}
                  className="w-[180px]"
                />
                <select
                  className={selectCls}
                  value={resultFilter}
                  onChange={(event) => setResultFilter(event.target.value as "all" | SynthesisRunResult)}
                >
                  <option value="all">All results</option>
                  <option value="success">Success</option>
                  <option value="partial">Partial</option>
                  <option value="failed">Failed</option>
                </select>
                <select
                  className={selectCls}
                  value={operationFilter}
                  onChange={(event) => setOperationFilter(event.target.value as SynthesisOperation)}
                >
                  <option value="all">All operations</option>
                  <option value="pattern">Pattern synthesis</option>
                  <option value="contradiction">Contradictions</option>
                  <option value="gap">Gap detection</option>
                  <option value="decay">Confidence decay</option>
                  <option value="validation">Validation rejected</option>
                </select>
              </div>

              {loading ? (
                <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-background/40 px-4 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading synthesis sweeps...
                </div>
              ) : filteredRuns.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/60 bg-background/30 px-4 py-8 text-sm text-muted-foreground">
                  No synthesis runs match the current filters.
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredRuns.map((run) => {
                    const expanded = expandedRuns.has(run.id)

                    return (
                      <div key={run.id} className="rounded-2xl border border-border/50 bg-background/35 p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge className={resultBadge(run.result)}>{run.result}</Badge>
                              <Badge variant="outline" className="border-border/60 bg-background/60">
                                {fmtDateTime(run.ts)}
                              </Badge>
                              <span className="text-sm text-muted-foreground">{fmtRelative(run.ts)}</span>
                            </div>
                            <p className="text-sm leading-6 text-foreground">{run.summary}</p>
                            <div className="flex flex-wrap gap-2 text-xs">
                              <Badge variant="outline">created {run.details.insights_created ?? 0}</Badge>
                              <Badge variant="outline">updated {run.details.insights_updated ?? 0}</Badge>
                              <Badge variant="outline">contradictions {run.details.contradictions_flagged ?? 0}</Badge>
                              <Badge variant="outline">gaps {run.details.gaps_created ?? 0}</Badge>
                              <Badge variant="outline">decayed {run.details.confidence_decayed ?? 0}</Badge>
                              <Badge variant="outline">validation rejected {run.details.validation_rejected ?? 0}</Badge>
                            </div>
                          </div>
                          <Button variant="outline" size="sm" onClick={() => toggleRun(run.id)}>
                            {expanded ? "Hide details" : "Drill in"}
                          </Button>
                        </div>

                        {expanded && (
                          <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                            <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                              <h3 className="text-sm font-medium text-foreground">Phase status</h3>
                              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                {[
                                  { key: "pattern", label: "Pattern", value: run.details.phase_status?.pattern ?? "n/a" },
                                  { key: "contradiction", label: "Contradiction", value: run.details.phase_status?.contradiction ?? "n/a" },
                                  { key: "gap", label: "Gap", value: run.details.phase_status?.gap ?? "n/a" },
                                  { key: "decay", label: "Decay", value: run.details.phase_status?.decay ?? "n/a" },
                                ].map((phase) => (
                                  <div key={phase.key} className="flex items-center justify-between rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-sm">
                                    <span>{phase.label}</span>
                                    <Badge variant="outline" className={phase.value === "error" ? "border-amber-500/30 bg-amber-500/15 text-amber-100" : ""}>
                                      {phase.value}
                                    </Badge>
                                  </div>
                                ))}
                              </div>
                              <div className="mt-4 text-sm text-muted-foreground">
                                Duration {fmtDuration(run.durationMs)}
                              </div>
                            </div>

                            <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                              <h3 className="text-sm font-medium text-foreground">Created insight links</h3>
                              {run.createdInsights.length === 0 ? (
                                <p className="mt-3 text-sm text-muted-foreground">
                                  No new synthetic insight nodes were matched to this run window.
                                </p>
                              ) : (
                                <div className="mt-3 space-y-3">
                                  {run.createdInsights.map((insight) => (
                                    <div key={insight.memoryId} className="rounded-lg border border-border/40 bg-background/60 p-3">
                                      <p className="text-sm leading-6 text-foreground">{excerpt(insight.content, 140)}</p>
                                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                        <span>{insight.memoryId}</span>
                                        <span>{fmtDateTime(insight.createdAt)}</span>
                                      </div>
                                      <div className="mt-3">
                                        <Button asChild size="sm" variant="outline">
                                          <Link href={`/dashboard/graph?memoryId=${encodeURIComponent(insight.memoryId)}`}>
                                            Open in graph
                                            <ArrowUpRight className="h-4 w-4" />
                                          </Link>
                                        </Button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="gap-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-2xl">
                    <Clock3 className="h-5 w-5 text-primary" />
                    Gap Lifecycle
                  </CardTitle>
                  <CardDescription>
                    Open and closed `knowledge_gap` memories with priority, age, suggested prompts, related evidence, and manual lifecycle control.
                  </CardDescription>
                </div>
                <select
                  className={selectCls}
                  value={gapStateFilter}
                  onChange={(event) => setGapStateFilter(event.target.value as GapStateFilter)}
                >
                  <option value="open">Open gaps</option>
                  <option value="all">All gaps</option>
                  <option value="closed">Closed gaps</option>
                </select>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-background/40 px-4 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading gap lifecycle...
                </div>
              ) : visibleGaps.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/60 bg-background/30 px-4 py-8 text-sm text-muted-foreground">
                  No gap memories match this lifecycle filter.
                </div>
              ) : (
                <div className="grid gap-4 xl:grid-cols-2">
                  {visibleGaps.map((gap) => {
                    const busy = actionKey === `gap:${gap.memoryId}:${gap.state === "open" ? "close" : "reopen"}`

                    return (
                      <div key={gap.memoryId} className="rounded-2xl border border-border/50 bg-background/35 p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge className={priorityBadge(gap.priority)}>{gap.priority}</Badge>
                              <Badge variant="outline" className={gap.state === "open" ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-200" : "border-border/60 bg-background/60"}>
                                {gap.state}
                              </Badge>
                              <span className="text-sm text-muted-foreground">{fmtDays(gap.createdAt)} old</span>
                            </div>
                            <h3 className="text-lg font-medium text-foreground">{gap.topic}</h3>
                            <p className="text-sm leading-6 text-muted-foreground">{excerpt(gap.content, 170)}</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleGapAction(gap.memoryId, gap.state === "open" ? "close" : "reopen")}
                            disabled={busy}
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                            {gap.state === "open" ? "Close gap" : "Reopen gap"}
                          </Button>
                        </div>

                        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
                          <div className="rounded-xl border border-border/40 bg-background/50 p-4">
                            <p className="text-sm font-medium text-foreground">Suggested prompts</p>
                            <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                              {gap.prompts.length === 0 ? (
                                <p>No prompts were recorded on this gap.</p>
                              ) : (
                                gap.prompts.map((prompt) => (
                                  <div key={prompt} className="rounded-lg border border-border/30 bg-background/60 px-3 py-2">
                                    {prompt}
                                  </div>
                                ))
                              )}
                            </div>
                          </div>

                          <div className="rounded-xl border border-border/40 bg-background/50 p-4">
                            <p className="text-sm font-medium text-foreground">Related memories</p>
                            <div className="mt-3 space-y-2">
                              {gap.relatedMemories.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No theme links were recorded for this gap.</p>
                              ) : (
                                gap.relatedMemories.map((memory) => (
                                  <div key={`${gap.memoryId}:${memory.memoryId}`} className="rounded-lg border border-border/30 bg-background/60 p-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="text-xs text-muted-foreground">
                                        {memory.primaryType} {memory.kind ? `· ${memory.kind}` : ""}
                                      </div>
                                      <Button asChild size="sm" variant="ghost" className="h-auto px-2 py-1">
                                        <Link href={`/dashboard/graph?memoryId=${encodeURIComponent(memory.memoryId)}`}>
                                          Graph
                                        </Link>
                                      </Button>
                                    </div>
                                    <p className="mt-2 text-sm leading-6 text-foreground">{excerpt(memory.content, 110)}</p>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>{gap.memoryId}</span>
                          <span>expires {gap.expiresAt ? fmtDateTime(gap.expiresAt) : "n/a"}</span>
                          <span>confidence {gap.confidence?.toFixed(2) ?? "n/a"}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="gap-3">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-2xl">
                    <GitCompareArrows className="h-5 w-5 text-primary" />
                    Contradiction Viewer
                  </CardTitle>
                  <CardDescription>
                    Side-by-side contradiction pairs shown as equal peers with the reconciliation note, both confidence scores, and manual dismiss.
                  </CardDescription>
                </div>
                <Badge variant="outline" className="border-border/60 bg-background/60">
                  {contradictions.length} pair{contradictions.length === 1 ? "" : "s"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-background/40 px-4 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading contradiction pairs...
                </div>
              ) : contradictions.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/60 bg-background/30 px-4 py-8 text-sm text-muted-foreground">
                  No contradiction pairs are currently flagged.
                </div>
              ) : (
                <div className="space-y-4">
                  {contradictions.map((pair) => {
                    const busy = actionKey === `contradiction:${pair.key}`

                    return (
                      <div key={pair.key} className="rounded-2xl border border-border/50 bg-background/35 p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge className="border-amber-500/30 bg-amber-500/15 text-amber-100">
                                contradiction
                              </Badge>
                              <Badge variant="outline" className="border-border/60 bg-background/60">
                                pair confidence {pair.confidence.toFixed(2)}
                              </Badge>
                              <span className="text-sm text-muted-foreground">{fmtDateTime(pair.resolvedAt)}</span>
                            </div>
                            <div className="rounded-xl border border-border/40 bg-background/55 px-4 py-3 text-sm leading-6 text-foreground">
                              {pair.note}
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleDismiss(pair)}
                            disabled={busy}
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                            Dismiss flag
                          </Button>
                        </div>

                        <div className="mt-4 grid gap-4 xl:grid-cols-2">
                          <MemoryPane memory={pair.left} />
                          <MemoryPane memory={pair.right} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-2xl">Dashboard Help</CardTitle>
              <CardDescription>
                A quick guide for reading the intelligence layer without over-interpreting it.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                <p className="text-sm font-medium text-foreground">Insights</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Synthetic insights are durable SEMANTIC memories created from repeated patterns across prior memories. They are summaries, not raw source facts.
                </p>
              </div>
              <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                <p className="text-sm font-medium text-foreground">Contradictions</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Contradictions are shown neutrally. The dashboard keeps both memories as equal peers, surfaces the reconciliation note, and never picks a winner automatically.
                </p>
              </div>
              <div className="rounded-xl border border-border/50 bg-background/40 p-4">
                <p className="text-sm font-medium text-foreground">Knowledge gaps</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Gaps mean the user keeps returning to a topic without a durable recorded stance yet. Closing a gap marks it resolved; reopening restores it for future prompting.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
