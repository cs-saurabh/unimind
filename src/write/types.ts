/** Write-path data shapes (handoff §7 write path). */
import type { PrimaryType, EntityType } from "../db/schema.js";

/** A captured conversational/tool event, emitted by a hook onto the ingest queue. */
export interface TurnEvent {
  sessionId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  ts: string; // RFC3339
  project?: string;
  toolName?: string; // when role === "tool"
  /** Boundary signal from the hook (Stop/SessionEnd/PreCompact/idle) — forces a flush. */
  boundary?: "stop" | "session_end" | "pre_compact" | "idle";
  /** Topic-shift signal from the read-path planner (§5.12) — forces a flush. Wired at step 4. */
  topicShifted?: boolean;
}

/** A turn that passed the salience gate and is buffered into the session window. */
export interface BufferedTurn {
  role: TurnEvent["role"];
  text: string;
  ts: string;
  toolName?: string;
  signals: string[]; // why salience kept it
}

export interface SessionBuffer {
  sessionId: string;
  project?: string;
  turns: BufferedTurn[];
  openedAt: string;
  lastTurnAt: string;
}

/** A self-contained memory proposed by the extraction LLM over a window. */
export interface CandidateMemory {
  content: string; // self-contained, entity-centric
  primaryType: PrimaryType;
  tags: string[];
  confidence: number; // 0..1
  salience: number; // 0..1 importance
  mentionRefs: number[]; // indices into MentionCluster[]
  // relational candidate (becomes a REL edge, §5.5) — subject/object are mentionRefs
  relation?: { subjectRef: number; predicate: string; objectRef: number } | null;
  temporalText?: string | null;
}

/** A coreference-resolved cluster of mentions of one real-world entity (in-window). */
export interface MentionCluster {
  canonicalName: string; // best surface form
  entityType: EntityType;
  surfaceForms: string[]; // every form seen in the window
}

export interface ExtractionResult {
  memories: CandidateMemory[];
  clusters: MentionCluster[];
}

export type FlushReason = "size" | "boundary" | "topic_shift" | "time_cap";
