'use client'

import { useCallback, useEffect, useState } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
import { Loader2, RefreshCw, ChevronRight, ScrollText, Info, X } from "lucide-react"

interface AuditRow {
    id: number
    ts: string
    category: string
    actor: string
    status: string
    sessionId: string | null
    tenantId: string
    userId: string
    summary: string
    details: Record<string, unknown> | null
    durationMs: number | null
}

interface CategoryInfo {
    category: string
    actor: string
    description: string
    example: string
}

const CATEGORY_INFO: CategoryInfo[] = [
    {
        category: "READ/inject", actor: "hook",
        description: "Automatic memory injection on every prompt. Plans the query, retrieves relevant memories (vector + BM25 + goals + contextual), ranks them, and injects a context header before Claude sees the prompt.",
        example: 'You ask "what’s our sprint cadence?" → it injects the saved fact "Sprint is 3 weeks, starts Tuesday" so Claude answers without you restating it.',
    },
    {
        category: "READ/recall", actor: "skill",
        description: "Explicit memory lookup via the recall tool — Claude digs deeper for background the user hasn’t restated. Embeds the query, retrieves and ranks matches, reinforces what it surfaces.",
        example: 'Claude calls recall("analytics-data-sync repo path") mid-task and gets back the saved local path + GitHub URL.',
    },
    {
        category: "WRITE/capture", actor: "hook",
        description: "A conversation turn was enqueued for the write pipeline. Fires on tool use, stop, session-end, pre-compact, and user prompts — the raw event capture that feeds buffering.",
        example: 'You run a Bash command → a PostToolUse turn ("enqueued tool Bash turn") is captured for later extraction.',
    },
    {
        category: "WRITE/flush", actor: "worker",
        description: "A session buffer was crystallized into long-term memory: extract over the window → resolve entities → resolve conflicts (dedup/supersede/extend) → persist memories and edges.",
        example: 'After 8 turns about the audit feature, a flush extracts "Audit logs stored in SQLite, worker is sole writer" and links it to the unimind entity.',
    },
    {
        category: "WRITE/remember", actor: "skill",
        description: "An explicit “remember this” via the remember tool. Runs the same extract → entity-resolve → conflict-resolve → persist pipeline immediately on the user-supplied statement.",
        example: 'You say "remember that I prefer Tailwind over CSS modules" → stored as a preference memory right away.',
    },
    {
        category: "CRON/sweep-idle", actor: "cron",
        description: "Runs every minute. Flushes session buffers that have gone quiet (hit the idle time-cap) so finished topics get crystallized without waiting for a boundary.",
        example: "You walk away mid-session; 15 min later the sweep flushes the dangling buffer so nothing discussed is lost.",
    },
    {
        category: "CRON/decay", actor: "cron",
        description: "Runs daily. Multiplies the weight of memories left unused past the idle threshold — the “use-it-or-lose-it” decay that lets unimportant memories fade.",
        example: "A one-off fact you haven’t touched in a week has its weight dropped from 1.0 → 0.9.",
    },
    {
        category: "CRON/forget", actor: "cron",
        description: "Runs daily. Soft-deletes memories that are weak, stale, and rarely used. Never touches PROCEDURAL (evergreen) or GOAL (lifecycle-managed) memories.",
        example: "A trivial detail with weight < 0.25 and unused for 45 days gets soft-deleted; your coding conventions (PROCEDURAL) stay.",
    },
    {
        category: "CRON/expire-contextual", actor: "cron",
        description: "Runs hourly. Physically removes CONTEXTUAL memories whose TTL has passed — the only memory type that is hard-deleted rather than soft-deleted.",
        example: '"Currently debugging the dev22 environment" expires and is dropped once its TTL lapses.',
    },
    {
        category: "CRON/er-repair", actor: "cron",
        description: "Runs daily. Entity-resolution repair: finds entity nodes that are really the same real-world thing (high similarity / shared name) and merges duplicates, re-pointing their links.",
        example: 'Separate "Saurabh" and "Saurabh Pawar" entity nodes get merged into one, and all mentions re-pointed.',
    },
    {
        category: "CRON/synthesis", actor: "cron",
        description: "Runs daily at 11:00. Scans all memories for patterns, flags contradictions between conflicting facts, creates knowledge gaps for things that should be known but aren't, and applies confidence decay to stale insights. Retries up to the configured max attempts with exponential backoff on failure.",
        example: 'Synthesis spots "I use Tailwind" and "I prefer CSS Modules" conflict, flags the pair for review, and drops the confidence on the older one.',
    },
    {
        category: "SYSTEM/bootstrap", actor: "worker",
        description: "Idempotent (re)creation of HelixDB indexes on worker startup. Safe to run repeatedly; ensures the tenant-partitioned vector/text/equality indexes exist before any read or write.",
        example: 'On worker restart, it (re)creates the 19 Helix indexes ("bootstrapped 19 Helix index(es)").',
    },
]

const CATEGORIES = CATEGORY_INFO.map((c) => c.category)
const ACTORS = ["hook", "skill", "cron", "worker"]
const PAGE_SIZE = 50

// Colour each category family so the table reads at a glance.
function categoryStyle(category: string): React.CSSProperties {
    const family = category.split("/")[0]
    const map: Record<string, { bg: string; fg: string }> = {
        READ: { bg: "#7E9CD833", fg: "#7E9CD8" },     // blue
        WRITE: { bg: "#98BB6C33", fg: "#98BB6C" },    // green
        CRON: { bg: "#DCA56133", fg: "#DCA561" },     // amber
        SYSTEM: { bg: "#957FB833", fg: "#957FB8" },   // purple
    }
    const c = map[family] ?? { bg: "#6b728033", fg: "#9ca3af" }
    return { backgroundColor: c.bg, color: c.fg, border: `1px solid ${c.fg}` }
}

function fmtTime(ts: string): { rel: string; abs: string } {
    const d = new Date(ts)
    return { rel: d.toISOString(), abs: d.toLocaleString() }
}

function actorStyle(actor: string): React.CSSProperties {
    const map: Record<string, { bg: string; fg: string }> = {
        hook: { bg: "#7E9CD833", fg: "#7E9CD8" },
        skill: { bg: "#98BB6C33", fg: "#98BB6C" },
        cron: { bg: "#DCA56133", fg: "#DCA561" },
        worker: { bg: "#957FB833", fg: "#957FB8" },
    }
    const c = map[actor] ?? { bg: "#6b728033", fg: "#9ca3af" }
    return { backgroundColor: c.bg, color: c.fg, border: `1px solid ${c.fg}` }
}

export default function AuditLogsPage() {
    const [rows, setRows] = useState<AuditRow[]>([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [expanded, setExpanded] = useState<Set<number>>(new Set())

    // Filters
    const [category, setCategory] = useState("")
    const [actor, setActor] = useState("")
    const [status, setStatus] = useState("")
    const [q, setQ] = useState("")
    const [offset, setOffset] = useState(0)
    const [autoRefresh, setAutoRefresh] = useState(true)
    const [showCategories, setShowCategories] = useState(false)

    const fetchLogs = useCallback(async () => {
        try {
            setError(null)
            const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
            if (category) params.set("category", category)
            if (actor) params.set("actor", actor)
            if (status) params.set("status", status)
            if (q) params.set("q", q)
            const res = await fetch(`/api/audit-logs?${params.toString()}`, { cache: "no-store" })
            const data = await res.json()
            if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`)
            setRows(data.rows ?? [])
            setTotal(data.total ?? 0)
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to fetch audit logs")
        } finally {
            setLoading(false)
        }
    }, [category, actor, status, q, offset])

    // Re-fetch on filter/page change (reset to first page when filters change).
    useEffect(() => { fetchLogs() }, [fetchLogs])
    useEffect(() => { setOffset(0) }, [category, actor, status, q])

    // Live polling.
    useEffect(() => {
        if (!autoRefresh) return
        const t = setInterval(fetchLogs, 3000)
        return () => clearInterval(t)
    }, [autoRefresh, fetchLogs])

    const toggleRow = (id: number) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id); else next.add(id)
            return next
        })
    }

    const selectCls = "h-8 rounded-md border border-input bg-background px-2 text-sm"

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
                                    <BreadcrumbPage>Audit Logs</BreadcrumbPage>
                                </BreadcrumbItem>
                            </BreadcrumbList>
                        </Breadcrumb>
                    </div>
                </header>

                <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
                    <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
                            <ScrollText className="h-6 w-6" />
                            <h1 className="text-3xl font-bold">Audit Logs</h1>
                        </div>
                        <Badge variant="secondary" className="text-sm">{total} events</Badge>
                        <p className="text-muted-foreground text-sm w-full md:w-auto">
                            Every memory operation — reads, writes, and maintenance — across hooks, the skill, and cron jobs.
                        </p>
                    </div>

                    {/* Filter bar */}
                    <div className="flex items-center gap-2 flex-wrap">
                        <select className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
                            <option value="">All categories</option>
                            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select className={selectCls} value={actor} onChange={(e) => setActor(e.target.value)}>
                            <option value="">All actors</option>
                            {ACTORS.map((a) => <option key={a} value={a}>{a}</option>)}
                        </select>
                        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
                            <option value="">All status</option>
                            <option value="ok">ok</option>
                            <option value="error">error</option>
                        </select>
                        <input
                            className={`${selectCls} w-56`}
                            placeholder="Search summary / details…"
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                        />
                        <button
                            className={`${selectCls} flex items-center gap-1 hover:bg-muted`}
                            onClick={() => fetchLogs()}
                        >
                            <RefreshCw className="h-3.5 w-3.5" /> Refresh
                        </button>
                        <button
                            className={`${selectCls} flex items-center gap-1 hover:bg-muted`}
                            onClick={() => setShowCategories(true)}
                        >
                            <Info className="h-3.5 w-3.5" /> Categories
                        </button>
                        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
                            Live
                        </label>
                    </div>

                    {showCategories && <CategoriesDialog onClose={() => setShowCategories(false)} />}

                    {error ? (
                        <div className="rounded-md border border-destructive p-4 text-destructive text-sm">{error}</div>
                    ) : loading ? (
                        <div className="flex items-center justify-center h-96">
                            <Loader2 className="h-8 w-8 animate-spin" />
                        </div>
                    ) : (
                        <div className="rounded-md border overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/50 text-left">
                                    <tr>
                                        <th className="w-8 p-2"></th>
                                        <th className="p-2 font-medium whitespace-nowrap">Time</th>
                                        <th className="p-2 font-medium">Category</th>
                                        <th className="p-2 font-medium">Actor</th>
                                        <th className="p-2 font-medium">Status</th>
                                        <th className="p-2 font-medium">Summary</th>
                                        <th className="p-2 font-medium text-right whitespace-nowrap">Duration</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.length === 0 ? (
                                        <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No audit events match these filters.</td></tr>
                                    ) : rows.map((row) => {
                                        const t = fmtTime(row.ts)
                                        const isOpen = expanded.has(row.id)
                                        return (
                                            <FragmentRow
                                                key={row.id}
                                                row={row}
                                                isOpen={isOpen}
                                                time={t}
                                                onToggle={() => toggleRow(row.id)}
                                            />
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* Pagination */}
                    {!loading && !error && total > PAGE_SIZE && (
                        <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">
                                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
                            </span>
                            <div className="flex gap-2">
                                <button
                                    className={`${selectCls} disabled:opacity-40`}
                                    disabled={offset === 0}
                                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                                >Previous</button>
                                <button
                                    className={`${selectCls} disabled:opacity-40`}
                                    disabled={offset + PAGE_SIZE >= total}
                                    onClick={() => setOffset(offset + PAGE_SIZE)}
                                >Next</button>
                            </div>
                        </div>
                    )}
                </div>
            </SidebarInset>
        </SidebarProvider>
    )
}

function FragmentRow({
    row, isOpen, time, onToggle,
}: {
    row: AuditRow
    isOpen: boolean
    time: { rel: string; abs: string }
    onToggle: () => void
}) {
    return (
        <>
            <tr className="border-t hover:bg-muted/30 cursor-pointer" onClick={onToggle}>
                <td className="p-2 align-top">
                    <ChevronRight className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                </td>
                <td className="p-2 align-top whitespace-nowrap" title={time.abs}>{time.rel}</td>
                <td className="p-2 align-top">
                    <Badge variant="secondary" className="text-xs font-semibold" style={categoryStyle(row.category)}>
                        {row.category}
                    </Badge>
                </td>
                <td className="p-2 align-top">
                    <Badge variant="secondary" className="text-xs font-semibold" style={actorStyle(row.actor)}>{row.actor}</Badge>
                </td>
                <td className="p-2 align-top">
                    <span style={{ color: row.status === "error" ? "#FF5D62" : row.status === "ok" ? "#98BB6C" : undefined }} className="font-medium">
                        {row.status}
                    </span>
                </td>
                <td className="p-2 align-top">{row.summary}</td>
                <td className="p-2 align-top text-right whitespace-nowrap text-muted-foreground">
                    {row.durationMs != null ? `${row.durationMs} ms` : "—"}
                </td>
            </tr>
            {isOpen && (
                <tr className="border-t bg-muted/20">
                    <td></td>
                    <td colSpan={6} className="p-3">
                        <div className="text-xs text-muted-foreground mb-2">
                            id={row.id} · session={row.sessionId ?? "—"} · tenant={row.tenantId} · user={row.userId}
                        </div>
                        <pre className="text-xs bg-background border rounded p-3 overflow-x-auto">
                            {row.details ? JSON.stringify(row.details, null, 2) : "(no details)"}
                        </pre>
                    </td>
                </tr>
            )}
        </>
    )
}

function CategoriesDialog({ onClose }: { onClose: () => void }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [onClose])

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={onClose}
        >
            <div
                className="bg-background border rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b p-4">
                    <div>
                        <h2 className="text-lg font-bold flex items-center gap-2">
                            <ScrollText className="h-5 w-5" /> Audit Categories
                        </h2>
                        <p className="text-sm text-muted-foreground mt-0.5">
                            Every kind of memory operation unimind records — and what each looks like in practice.
                        </p>
                    </div>
                    <button className="p-1 rounded hover:bg-muted" onClick={onClose} aria-label="Close">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="overflow-auto p-4">
                    <table className="w-full text-sm border-separate border-spacing-y-2">
                        <thead className="text-left text-muted-foreground">
                            <tr>
                                <th className="font-medium pr-3 align-bottom">Category</th>
                                <th className="font-medium pr-3 align-bottom">Actor</th>
                                <th className="font-medium pr-3 align-bottom">Description</th>
                                <th className="font-medium align-bottom">Real-world example</th>
                            </tr>
                        </thead>
                        <tbody>
                            {CATEGORY_INFO.map((c) => (
                                <tr key={c.category} className="align-top">
                                    <td className="pr-3 py-1 whitespace-nowrap">
                                        <Badge variant="secondary" className="text-xs font-semibold" style={categoryStyle(c.category)}>
                                            {c.category}
                                        </Badge>
                                    </td>
                                    <td className="pr-3 py-1"><Badge variant="secondary" className="text-xs font-semibold" style={actorStyle(c.actor)}>{c.actor}</Badge></td>
                                    <td className="pr-3 py-1 text-muted-foreground min-w-[18rem]">{c.description}</td>
                                    <td className="py-1 min-w-[16rem]">{c.example}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}
