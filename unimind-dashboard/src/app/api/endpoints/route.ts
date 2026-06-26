// UniMind adapter: enterprise-dev has no stored named queries to introspect, so we
// expose a curated set of memory operations as "endpoints" the query browser can run.
// Each maps to a dynamic /v1/query in /api/query/[queryName]. Names use get/search
// prefixes so the page infers GET; params render as a form.
import { NextResponse } from "next/server";

const ENDPOINTS = [
  { query_name: "getMemories", parameters: [{ name: "limit", param_type: "I64" }] },
  { query_name: "searchMemories", parameters: [{ name: "text", param_type: "String" }, { name: "limit", param_type: "I64" }] },
  { query_name: "getMemoriesByType", parameters: [{ name: "primaryType", param_type: "String" }, { name: "limit", param_type: "I64" }] },
  { query_name: "getGoals", parameters: [] },
  { query_name: "getEntities", parameters: [{ name: "limit", param_type: "I64" }] },
  { query_name: "getEntityRelations", parameters: [{ name: "name", param_type: "String" }] },
].map((e) => ({ path: `/api/query/${e.query_name}`, method: "GET", query_name: e.query_name, parameters: e.parameters }));

export async function GET() {
  return NextResponse.json(ENDPOINTS);
}
