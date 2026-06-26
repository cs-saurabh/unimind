// UniMind adapter: enterprise-dev has no /introspect, so serve the known schema (§6).
import { NextResponse } from "next/server";
import { SCHEMA } from "@/lib/helix";

export async function GET() {
  return NextResponse.json(SCHEMA);
}
