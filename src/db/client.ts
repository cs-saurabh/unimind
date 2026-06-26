import { Client } from "@helix-db/helix-db";
import { HELIX_URL } from "../config.js";

/** Shared Helix client. Workers use the SDK/API, never the CLI on hot paths (§11). */
export const helix = new Client(HELIX_URL);

/**
 * Run a write request, retrying on HTTP 409 concurrent-write conflicts (read-then-write
 * memory updates race across sessions — the skill flags this). Caller owns the request.
 */
export async function writeWithRetry<R = any>(
  req: any,
  { retries = 4, baseMs = 50 }: { retries?: number; baseMs?: number } = {},
): Promise<R> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await helix.query<R>().shouldAwaitDurability(true).dynamic(req).send();
    } catch (e: any) {
      const conflict = /conflict/i.test(e?.message ?? "");
      if (!conflict || attempt === retries) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt + attempt * 7));
    }
  }
  throw lastErr;
}
