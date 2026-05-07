import type { Database as DB } from "better-sqlite3";
import type { Repo } from "./repo.js";
import type { Node } from "./schema.js";
import { embed as voyageEmbed } from "../llm/voyage.js";
import { embed as localEmbed } from "../llm/local_embedding.js";
import { MODELS } from "../llm/models.js";

/**
 * Voyage models always start with "voyage-". Anything else (the default
 * `Xenova/all-MiniLM-L6-v2`, other HuggingFace ids) routes to the local
 * transformers.js client.
 */
function isVoyageModel(model: string): boolean {
  return model.toLowerCase().startsWith("voyage-");
}

async function embed(opts: {
  model: string;
  inputs: string[];
  input_type?: "document" | "query";
}): Promise<{
  vectors: Float32Array[];
  dim: number;
  model: string;
  usage: { total_tokens: number };
}> {
  if (isVoyageModel(opts.model)) {
    return voyageEmbed(opts);
  }
  return localEmbed({ model: opts.model, inputs: opts.inputs });
}

/**
 * Render a node into the text we embed. Title carries the strongest signal;
 * body adds the substance.
 */
export function nodeText(n: Pick<Node, "title" | "body" | "type">): string {
  return `[${n.type}] ${n.title}\n\n${n.body}`.trim();
}

/** Float32Array <-> Buffer round-trip for SQLite BLOB storage. */
function floatsToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function bufferToFloats(b: Buffer): Float32Array {
  // Buffer is a Uint8Array view; copy bytes into a fresh Float32Array.
  const copy = new ArrayBuffer(b.byteLength);
  new Uint8Array(copy).set(b);
  return new Float32Array(copy);
}

export interface EmbeddingRow {
  node_id: string;
  model: string;
  dim: number;
  vector: Float32Array;
  node_revision: number;
  created_at: number;
}

export class EmbeddingsRepo {
  constructor(
    private readonly db: DB,
    private readonly repo: Repo,
  ) {}

  upsert(args: {
    node_id: string;
    model: string;
    vector: Float32Array;
    node_revision: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (node_id, model, dim, vector, node_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           model = excluded.model,
           dim = excluded.dim,
           vector = excluded.vector,
           node_revision = excluded.node_revision,
           created_at = excluded.created_at`,
      )
      .run(
        args.node_id,
        args.model,
        args.vector.length,
        floatsToBuffer(args.vector),
        args.node_revision,
        Date.now(),
      );
  }

  get(nodeId: string): EmbeddingRow | null {
    const row = this.db
      .prepare("SELECT * FROM embeddings WHERE node_id = ?")
      .get(nodeId) as
      | (Omit<EmbeddingRow, "vector"> & { vector: Buffer })
      | undefined;
    if (!row) return null;
    return { ...row, vector: bufferToFloats(row.vector) };
  }

  /** Return all embeddings for a given model. */
  allForModel(model: string): EmbeddingRow[] {
    const rows = this.db
      .prepare("SELECT * FROM embeddings WHERE model = ?")
      .all(model) as (Omit<EmbeddingRow, "vector"> & { vector: Buffer })[];
    return rows.map((r) => ({ ...r, vector: bufferToFloats(r.vector) }));
  }

  delete(nodeId: string): void {
    this.db.prepare("DELETE FROM embeddings WHERE node_id = ?").run(nodeId);
  }

  /**
   * Brute-force top-K cosine-nearest neighbors. Linear scan over the embeddings
   * table for the requested model. Fine to ~10K nodes; switch to sqlite-vec
   * (or external vector DB) if we get bigger.
   */
  nearestNeighbors(
    query: Float32Array,
    opts: {
      model: string;
      k?: number;
      excludeNodeIds?: Set<string>;
      minSimilarity?: number;
    },
  ): { node_id: string; similarity: number }[] {
    const k = opts.k ?? 10;
    const exclude = opts.excludeNodeIds ?? new Set();
    const min = opts.minSimilarity ?? -1;
    const rows = this.allForModel(opts.model);
    const scored: { node_id: string; similarity: number }[] = [];
    for (const r of rows) {
      if (exclude.has(r.node_id)) continue;
      if (r.dim !== query.length) continue;
      const sim = cosine(query, r.vector);
      if (sim < min) continue;
      scored.push({ node_id: r.node_id, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Embed a batch of nodes via the OpenAI API and persist the vectors. Uses the
 * configured embedding model. Returns the (node_id, vector) pairs for use by
 * the caller (e.g., dedupe phase) without re-fetching from the DB.
 */
/**
 * Find nodes whose stored embedding is missing or stale relative to the given
 * model + revision. Returns the subset that needs (re-)embedding.
 */
export function nodesNeedingEmbedding(
  embeddings: EmbeddingsRepo,
  nodes: Node[],
  model: string,
): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    const e = embeddings.get(n.id);
    if (!e) {
      out.push(n);
      continue;
    }
    if (e.model !== model) {
      out.push(n);
      continue;
    }
    if (e.node_revision !== n.revision) {
      out.push(n);
      continue;
    }
  }
  return out;
}

/**
 * Backfill embeddings for any node lacking a current vector under `model`.
 * Returns the count of newly-embedded nodes and the total token usage.
 * Batches into chunks of `chunkSize` to keep individual API calls bounded.
 */
export async function backfillEmbeddings(
  embeddings: EmbeddingsRepo,
  repo: Repo,
  args: {
    model?: string;
    chunkSize?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<{
  embedded: number;
  alreadyHad: number;
  usageTokens: number;
  dim: number;
  model: string;
}> {
  const model = args.model ?? MODELS.embedding;
  const chunkSize = args.chunkSize ?? 100;
  const allNodes = repo.listNodes();
  const need = nodesNeedingEmbedding(embeddings, allNodes, model);
  const alreadyHad = allNodes.length - need.length;

  let usageTokens = 0;
  let dim = 0;
  let done = 0;
  for (let i = 0; i < need.length; i += chunkSize) {
    const chunk = need.slice(i, i + chunkSize);
    const r = await embedAndStore(embeddings, repo, chunk, model);
    usageTokens += r.usage.total_tokens;
    if (r.dim) dim = r.dim;
    done += chunk.length;
    args.onProgress?.(done, need.length);
  }

  return {
    embedded: need.length,
    alreadyHad,
    usageTokens,
    dim,
    model,
  };
}

export async function embedAndStore(
  embeddings: EmbeddingsRepo,
  repo: Repo,
  nodes: Node[],
  model: string = MODELS.embedding,
): Promise<{
  vectors: Map<string, Float32Array>;
  usage: { total_tokens: number };
  dim: number;
}> {
  if (nodes.length === 0) {
    return { vectors: new Map(), usage: { total_tokens: 0 }, dim: 0 };
  }
  const inputs = nodes.map((n) => nodeText(n));
  const result = await embed({ model, inputs, input_type: "document" });
  const vectors = new Map<string, Float32Array>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const vec = result.vectors[i];
    if (!node || !vec) continue;
    vectors.set(node.id, vec);
    embeddings.upsert({
      node_id: node.id,
      model,
      vector: vec,
      node_revision: node.revision,
    });
  }
  void repo; // reserved for future event recording
  return { vectors, usage: result.usage, dim: result.dim };
}
