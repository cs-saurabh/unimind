import { readFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { EMBED_MODEL, EMBED_DIM } from "../config.js";

function loadEnv() {
  if (process.env.OPENAI_API_KEY) return;
  try {
    const root = join(import.meta.dirname, "..", "..");
    for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnv();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Embed one or many texts with the fixed memory-store model. Returns F32-ready arrays. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await client.embeddings.create({ model: EMBED_MODEL, input: texts });
  const out = res.data.map((d) => d.embedding);
  for (const v of out) {
    if (v.length !== EMBED_DIM) throw new Error(`embedding dim ${v.length} != ${EMBED_DIM}`);
  }
  return out;
}

export const embedOne = async (t: string) => (await embed([t]))[0];
