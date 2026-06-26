/**
 * Read API for the audit log (worker-only). A tiny HTTP server the dashboard proxies to
 * (GET /api/audit-logs → here). Reachable from the dashboard container as worker:<port>
 * over the compose network; also published for local debugging.
 */
import { createServer } from "node:http";
import { queryLogs, distinctFacets } from "./db.js";

function sendJson(res: any, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function startAuditServer(port = 48180): void {
  const server = createServer((req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && u.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && u.pathname === "/facets") {
        sendJson(res, 200, distinctFacets());
        return;
      }

      if (req.method === "GET" && u.pathname === "/audit") {
        const p = u.searchParams;
        const limit = Math.min(Math.max(Number(p.get("limit") ?? "100") || 100, 1), 500);
        const offset = Math.max(Number(p.get("offset") ?? "0") || 0, 0);
        const out = queryLogs({
          limit,
          offset,
          category: p.get("category") || undefined,
          actor: p.get("actor") || undefined,
          status: p.get("status") || undefined,
          since: p.get("since") || undefined,
          q: p.get("q") || undefined,
        });
        sendJson(res, 200, { ...out, limit, offset });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error)?.message ?? "internal error" });
    }
  });

  server.listen(port, () => console.info(`[audit] read API listening on :${port}`));
}
