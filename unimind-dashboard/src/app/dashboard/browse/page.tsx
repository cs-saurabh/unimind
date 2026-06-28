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
import { Loader2, Table2 } from "lucide-react"

type Row = Record<string, unknown>

const PAGE_SIZE = 50

const PRIMARY_TYPES = ["EPISODIC", "SEMANTIC", "PROCEDURAL", "CONTEXTUAL", "GOAL"]

const PRIMARY_TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
    EPISODIC: { bg: "#f59e0b33", fg: "#f59e0b" },
    SEMANTIC: { bg: "#06b6d433", fg: "#06b6d4" },
    PROCEDURAL: { bg: "#8b5cf633", fg: "#8b5cf6" },
    CONTEXTUAL: { bg: "#e2e8f033", fg: "#64748b" },
    GOAL: { bg: "#ec489933", fg: "#ec4899" },
}

const MEMORY_COLUMNS = [
    "id", "label", "memoryId", "primaryType", "kind", "content", "tags",
    "weight", "confidence", "freshness", "accessCount",
    "status", "hasContradiction", "isLatest", "stalenessFlag", "decayPolicy",
    "basis", "costIfIgnored", "derivedFrom", "contradictions",
    "createdAt", "updatedAt", "lastAccessedAt", "lastRevisedAt",
    "validFrom", "validTo", "expiresAt", "sourceSessionId",
]

const ENTITY_COLUMNS = [
    "id", "label", "entityKey", "name", "entityType", "aliases",
    "confidence", "createdAt", "updatedAt",
]

const DATE_COLS = new Set([
    "createdAt", "updatedAt", "lastAccessedAt", "lastRevisedAt",
    "validFrom", "validTo", "expiresAt",
])

function camelToTitle(str: string): string {
    const spaced = str.replace(/([A-Z])/g, " $1")
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function Pills({ values }: { values: unknown }) {
    if (!Array.isArray(values) || values.length === 0)
        return <span className="text-muted-foreground text-xs">—</span>
    return (
        <div className="flex flex-wrap gap-1">
            {values.map((v, i) => (
                <span key={i} className="border rounded px-1.5 py-0.5 text-xs whitespace-nowrap">
                    {String(v)}
                </span>
            ))}
        </div>
    )
}

function AliasesPills({ values }: { values: unknown }) {
    if (!Array.isArray(values) || values.length === 0)
        return <span className="text-muted-foreground text-xs">—</span>
    return (
        <div className="flex gap-1 overflow-x-auto max-w-[200px]" style={{ flexWrap: "nowrap" }}>
            {values.map((v, i) => (
                <span key={i} className="border rounded px-1.5 py-0.5 text-xs whitespace-nowrap flex-shrink-0">
                    {String(v)}
                </span>
            ))}
        </div>
    )
}

function renderMemoryCell(col: string, value: unknown): React.ReactNode {
    if (value === null || value === undefined)
        return <span className="text-muted-foreground text-xs">—</span>

    if (col === "primaryType") {
        const c = PRIMARY_TYPE_COLORS[String(value)] ?? { bg: "#6b728033", fg: "#9ca3af" }
        return (
            <Badge variant="secondary" className="text-xs font-semibold" style={{ backgroundColor: c.bg, color: c.fg, border: `1px solid ${c.fg}` }}>
                {String(value)}
            </Badge>
        )
    }

    if (col === "content") {
        const str = String(value)
        return (
            <span title={str} className="cursor-default">
                {str.length > 80 ? str.slice(0, 80) + "…" : str}
            </span>
        )
    }

    if (col === "tags" || col === "derivedFrom") return <Pills values={value} />

    if (col === "contradictions") {
        if (!Array.isArray(value)) return <span className="text-muted-foreground text-xs">—</span>
        return <span className="text-xs text-muted-foreground">{value.length} item{value.length !== 1 ? "s" : ""}</span>
    }

    if (col === "hasContradiction" || col === "isLatest") {
        return (
            <span className={`text-xs font-medium ${value ? "text-amber-400" : "text-muted-foreground"}`}>
                {value ? "yes" : "no"}
            </span>
        )
    }

    if (DATE_COLS.has(col)) {
        try { return <span className="whitespace-nowrap text-xs">{new Date(String(value)).toISOString()}</span> }
        catch { return <span className="text-xs">{String(value)}</span> }
    }

    if (typeof value === "number") {
        return <span className="text-xs">{Number.isInteger(value) ? value : value.toFixed(3)}</span>
    }

    if (Array.isArray(value)) return <Pills values={value} />

    return <span className="text-xs">{String(value)}</span>
}

function renderEntityCell(col: string, value: unknown): React.ReactNode {
    if (value === null || value === undefined)
        return <span className="text-muted-foreground text-xs">—</span>

    if (col === "aliases") return <AliasesPills values={value} />

    if (DATE_COLS.has(col)) {
        try { return <span className="whitespace-nowrap text-xs">{new Date(String(value)).toISOString()}</span> }
        catch { return <span className="text-xs">{String(value)}</span> }
    }

    if (typeof value === "number") {
        return <span className="text-xs">{Number.isInteger(value) ? value : value.toFixed(3)}</span>
    }

    return <span className="text-xs">{String(value)}</span>
}

function Pagination({
    total, offset, onPageChange,
}: { total: number; offset: number; onPageChange: (o: number) => void }) {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const currentPage = Math.floor(offset / PAGE_SIZE) + 1

    return (
        <div className="flex items-center justify-between text-sm mt-3">
            <span className="text-muted-foreground text-xs">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex items-center gap-2">
                <button
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-40"
                    disabled={offset === 0}
                    onClick={() => onPageChange(Math.max(0, offset - PAGE_SIZE))}
                >Prev</button>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    Page
                    <input
                        type="number"
                        min={1}
                        max={totalPages}
                        value={currentPage}
                        onChange={(e) => {
                            const p = Math.max(1, Math.min(totalPages, Number(e.target.value)))
                            onPageChange((p - 1) * PAGE_SIZE)
                        }}
                        className="h-7 w-14 rounded-md border border-input bg-background px-1.5 text-sm text-center"
                    />
                    of {totalPages}
                </div>
                <button
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-40"
                    disabled={offset + PAGE_SIZE >= total}
                    onClick={() => onPageChange(offset + PAGE_SIZE)}
                >Next</button>
            </div>
        </div>
    )
}

const selectCls = "h-8 rounded-md border border-input bg-background px-2 text-sm"
const inputCls = `${selectCls} w-40`

export default function BrowsePage() {
    const [tab, setTab] = useState<"memories" | "entities">("memories")

    // — Memories state —
    const [memRows, setMemRows] = useState<Row[]>([])
    const [memTotal, setMemTotal] = useState(0)
    const [memLoading, setMemLoading] = useState(false)
    const [memError, setMemError] = useState<string | null>(null)
    const [memOffset, setMemOffset] = useState(0)
    const [memQ, setMemQ] = useState("")
    const [memPrimaryType, setMemPrimaryType] = useState("")
    const [memStatus, setMemStatus] = useState("")
    const [memFrom, setMemFrom] = useState("")
    const [memTo, setMemTo] = useState("")

    // — Entities state —
    const [entRows, setEntRows] = useState<Row[]>([])
    const [entTotal, setEntTotal] = useState(0)
    const [entLoading, setEntLoading] = useState(false)
    const [entError, setEntError] = useState<string | null>(null)
    const [entOffset, setEntOffset] = useState(0)
    const [entQ, setEntQ] = useState("")
    const [entEntityType, setEntEntityType] = useState("")
    const [entFrom, setEntFrom] = useState("")
    const [entTo, setEntTo] = useState("")

    const fetchMemories = useCallback(async () => {
        setMemLoading(true)
        setMemError(null)
        try {
            const p = new URLSearchParams({ offset: String(memOffset) })
            if (memQ) p.set("q", memQ)
            if (memPrimaryType) p.set("primaryType", memPrimaryType)
            if (memStatus) p.set("status", memStatus)
            if (memFrom) p.set("from", new Date(memFrom).toISOString())
            if (memTo) p.set("to", new Date(memTo + "T23:59:59.999Z").toISOString())
            const res = await fetch(`/api/browse/memories?${p}`, { cache: "no-store" })
            const data = await res.json()
            if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`)
            setMemRows(data.rows ?? [])
            setMemTotal(data.total ?? 0)
        } catch (err) {
            setMemError(err instanceof Error ? err.message : "Failed to fetch memories")
        } finally {
            setMemLoading(false)
        }
    }, [memOffset, memQ, memPrimaryType, memStatus, memFrom, memTo])

    const fetchEntities = useCallback(async () => {
        setEntLoading(true)
        setEntError(null)
        try {
            const p = new URLSearchParams({ offset: String(entOffset) })
            if (entQ) p.set("q", entQ)
            if (entEntityType) p.set("entityType", entEntityType)
            if (entFrom) p.set("from", new Date(entFrom).toISOString())
            if (entTo) p.set("to", new Date(entTo + "T23:59:59.999Z").toISOString())
            const res = await fetch(`/api/browse/entities?${p}`, { cache: "no-store" })
            const data = await res.json()
            if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`)
            setEntRows(data.rows ?? [])
            setEntTotal(data.total ?? 0)
        } catch (err) {
            setEntError(err instanceof Error ? err.message : "Failed to fetch entities")
        } finally {
            setEntLoading(false)
        }
    }, [entOffset, entQ, entEntityType, entFrom, entTo])

    // Fetch on mount and when memories filters/offset change
    useEffect(() => { fetchMemories() }, [fetchMemories])
    // Reset offset when memories filters change
    useEffect(() => { setMemOffset(0) }, [memQ, memPrimaryType, memStatus, memFrom, memTo])

    // Fetch entities only when tab is active
    useEffect(() => { if (tab === "entities") fetchEntities() }, [tab, fetchEntities])
    // Reset offset when entities filters change
    useEffect(() => { setEntOffset(0) }, [entQ, entEntityType, entFrom, entTo])

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
                                    <BreadcrumbPage>Browse</BreadcrumbPage>
                                </BreadcrumbItem>
                            </BreadcrumbList>
                        </Breadcrumb>
                    </div>
                </header>

                <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
                    {/* Page title */}
                    <div className="flex items-center gap-3">
                        <Table2 className="h-6 w-6" />
                        <h1 className="text-3xl font-bold">Browse</h1>
                        <Badge variant="secondary" className="text-sm">
                            {tab === "memories" ? memTotal : entTotal} {tab}
                        </Badge>
                    </div>

                    {/* Tab switcher */}
                    <div className="flex border-b gap-0">
                        {(["memories", "entities"] as const).map((t) => (
                            <button
                                key={t}
                                onClick={() => setTab(t)}
                                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                                    tab === t
                                        ? "border-foreground text-foreground"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
                                }`}
                            >
                                {t.charAt(0).toUpperCase() + t.slice(1)}
                            </button>
                        ))}
                    </div>

                    {/* Memories tab */}
                    {tab === "memories" && (
                        <>
                            {/* Filter bar */}
                            <div className="flex items-center gap-2 flex-wrap">
                                <input
                                    className={`${selectCls} w-56`}
                                    placeholder="Search content…"
                                    value={memQ}
                                    onChange={(e) => setMemQ(e.target.value)}
                                />
                                <select className={selectCls} value={memPrimaryType} onChange={(e) => setMemPrimaryType(e.target.value)}>
                                    <option value="">All Types</option>
                                    {PRIMARY_TYPES.map((t) => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                                <select className={selectCls} value={memStatus} onChange={(e) => setMemStatus(e.target.value)}>
                                    <option value="">All Status</option>
                                    <option value="active">active</option>
                                    <option value="deleted">deleted</option>
                                </select>
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    From
                                    <input type="date" className={inputCls} value={memFrom} onChange={(e) => setMemFrom(e.target.value)} />
                                </div>
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    To
                                    <input type="date" className={inputCls} value={memTo} onChange={(e) => setMemTo(e.target.value)} />
                                </div>
                                {(memQ || memPrimaryType || memStatus || memFrom || memTo) && (
                                    <button
                                        className={`${selectCls} text-muted-foreground hover:bg-muted`}
                                        onClick={() => { setMemQ(""); setMemPrimaryType(""); setMemStatus(""); setMemFrom(""); setMemTo("") }}
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>

                            {memError ? (
                                <div className="rounded-md border border-destructive p-4 text-destructive text-sm">{memError}</div>
                            ) : memLoading ? (
                                <div className="flex items-center justify-center h-64">
                                    <Loader2 className="h-8 w-8 animate-spin" />
                                </div>
                            ) : (
                                <div className="rounded-md border overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead className="bg-muted/50 text-left">
                                            <tr>
                                                {MEMORY_COLUMNS.map((col) => (
                                                    <th key={col} className="p-2 font-medium whitespace-nowrap">
                                                        {camelToTitle(col)}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {memRows.length === 0 ? (
                                                <tr>
                                                    <td colSpan={MEMORY_COLUMNS.length} className="p-6 text-center text-muted-foreground">
                                                        No memories match these filters.
                                                    </td>
                                                </tr>
                                            ) : memRows.map((row, i) => (
                                                <tr key={String(row.id ?? i)} className="border-t hover:bg-muted/30">
                                                    {MEMORY_COLUMNS.map((col) => (
                                                        <td key={col} className="p-2 align-top max-w-[300px]">
                                                            {renderMemoryCell(col, row[col])}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            {!memLoading && !memError && memTotal > PAGE_SIZE && (
                                <Pagination total={memTotal} offset={memOffset} onPageChange={setMemOffset} />
                            )}
                        </>
                    )}

                    {/* Entities tab */}
                    {tab === "entities" && (
                        <>
                            {/* Filter bar */}
                            <div className="flex items-center gap-2 flex-wrap">
                                <input
                                    className={`${selectCls} w-56`}
                                    placeholder="Search name, key, aliases…"
                                    value={entQ}
                                    onChange={(e) => setEntQ(e.target.value)}
                                />
                                <input
                                    className={`${selectCls} w-40`}
                                    placeholder="Entity type…"
                                    value={entEntityType}
                                    onChange={(e) => setEntEntityType(e.target.value)}
                                />
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    From
                                    <input type="date" className={inputCls} value={entFrom} onChange={(e) => setEntFrom(e.target.value)} />
                                </div>
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    To
                                    <input type="date" className={inputCls} value={entTo} onChange={(e) => setEntTo(e.target.value)} />
                                </div>
                                {(entQ || entEntityType || entFrom || entTo) && (
                                    <button
                                        className={`${selectCls} text-muted-foreground hover:bg-muted`}
                                        onClick={() => { setEntQ(""); setEntEntityType(""); setEntFrom(""); setEntTo("") }}
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>

                            {entError ? (
                                <div className="rounded-md border border-destructive p-4 text-destructive text-sm">{entError}</div>
                            ) : entLoading ? (
                                <div className="flex items-center justify-center h-64">
                                    <Loader2 className="h-8 w-8 animate-spin" />
                                </div>
                            ) : (
                                <div className="rounded-md border overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead className="bg-muted/50 text-left">
                                            <tr>
                                                {ENTITY_COLUMNS.map((col) => (
                                                    <th key={col} className="p-2 font-medium whitespace-nowrap">
                                                        {camelToTitle(col)}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {entRows.length === 0 ? (
                                                <tr>
                                                    <td colSpan={ENTITY_COLUMNS.length} className="p-6 text-center text-muted-foreground">
                                                        No entities match these filters.
                                                    </td>
                                                </tr>
                                            ) : entRows.map((row, i) => (
                                                <tr key={String(row.id ?? i)} className="border-t hover:bg-muted/30">
                                                    {ENTITY_COLUMNS.map((col) => (
                                                        <td key={col} className="p-2 align-top">
                                                            {renderEntityCell(col, row[col])}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            {!entLoading && !entError && entTotal > PAGE_SIZE && (
                                <Pagination total={entTotal} offset={entOffset} onPageChange={setEntOffset} />
                            )}
                        </>
                    )}
                </div>
            </SidebarInset>
        </SidebarProvider>
    )
}
