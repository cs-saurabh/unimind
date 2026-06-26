import { readFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";

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

/** Cheap hot-path model for gray-zone adjudication, planning, and shift detection (validated: gpt-4o-mini, not nano — §5.12). */
export const HOT_MODEL = process.env.UNIMIND_HOT_MODEL ?? "gpt-4o-mini";

/**
 * Structured JSON completion. The reusable vehicle for every LLM-on-gray call
 * (entity-link adjudication, conflict classification, read-path planning). Forces
 * a JSON object response and parses it; caller validates the shape.
 */
export async function jsonComplete<T = any>(opts: {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<T> {
  // json_object mode requires the literal lowercase word "json" in the messages
  // (uppercase "JSON" does not satisfy the API check).
  const system = opts.system.includes("json") ? opts.system : `${opts.system}\nRespond with a json object.`;
  const res = await client.chat.completions.create({
    model: opts.model ?? HOT_MODEL,
    temperature: opts.temperature ?? 0,
    max_completion_tokens: opts.maxTokens ?? 512,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: opts.user },
    ],
  });
  return JSON.parse(res.choices[0].message.content || "{}") as T;
}
