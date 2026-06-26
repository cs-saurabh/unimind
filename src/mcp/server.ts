/**
 * UniMind MCP server — exposes the recall() tool to Claude Code (§5.9 pull half).
 * The push header arrives automatically each turn; this lets Claude explicitly dig
 * deeper when it needs background the user hasn't restated.
 *
 * Register once with Claude Code:
 *   claude mcp add unimind -- npx tsx <repo>/src/mcp/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recall } from "../read/recall.js";
import { remember } from "../write/remember.js";
import { audit } from "../audit/emit.js";

const server = new McpServer({ name: "unimind", version: "0.1.0" });

server.registerTool(
  "recall",
  {
    description:
      "Search the user's long-term memory for relevant facts, preferences, decisions, " +
      "goals, relationships, and past project context. Use when you need background the " +
      "user hasn't restated in this conversation.",
    inputSchema: {
      query: z.string().describe("what to look up, in natural language"),
      limit: z.number().int().min(1).max(25).optional().describe("max memories to return (default 8)"),
    },
  },
  async ({ query, limit }) => {
    const startedAt = Date.now();
    const mems = await recall(query, limit ?? 8);
    audit({
      category: "READ/recall", actor: "skill",
      summary: `recall "${query.slice(0, 60)}" → ${mems.length} memory(ies)`,
      details: {
        query: query.slice(0, 200), limit: limit ?? 8, returned: mems.length,
        types: mems.map((m) => m.primaryType),
      },
      durationMs: Date.now() - startedAt,
    });
    const text = mems.length
      ? mems.map((m) => `- [${m.primaryType}] ${m.content}`).join("\n")
      : "(no relevant memories found)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "remember",
  {
    description:
      "Store information in the user's long-term memory on demand. Use when the user " +
      "explicitly asks to remember/save/note something, or states a durable fact, " +
      "preference, decision, or goal worth persisting across sessions. The text is " +
      "extracted, typed, entity-linked, and de-duplicated against existing memories " +
      "automatically (a restatement reinforces rather than duplicates).",
    inputSchema: {
      content: z
        .string()
        .describe("the information to remember, as a clear, self-contained statement"),
    },
  },
  async ({ content }) => {
    const r = await remember(content);
    let text: string;
    if (r.memories > 0) {
      text = `Remembered. Stored ${r.memories} memory${r.memories > 1 ? "ies" : ""}` +
        (r.superseded ? `, superseded ${r.superseded} older one(s)` : "") +
        (r.entitiesCreated || r.entitiesLinked ? ` (entities: ${r.entitiesCreated} new, ${r.entitiesLinked} linked).` : ".");
    } else if (r.reinforced > 0) {
      text = "Already known — reinforced the existing memory instead of duplicating.";
    } else {
      text = "Nothing durable enough to store was found in that statement.";
    }
    return { content: [{ type: "text", text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
