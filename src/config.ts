/**
 * Single-user configuration. tenant_id / userId are fixed here (v1 is a personal
 * tool — §3) but kept on every node/edge so multi-tenant (v2) needs no reshaping
 * and so Helix's tenant-partitioned vector/text indexes work.
 */
export const TENANT_ID = process.env.UNIMIND_TENANT ?? "unimind";
export const USER_ID = process.env.UNIMIND_USER ?? "default";

export const HELIX_URL = process.env.HELIX_URL ?? "http://localhost:6969";

/** OpenAI text-embedding-3-small — keep model+dim fixed per the vector indexes. */
export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIM = 1536;
