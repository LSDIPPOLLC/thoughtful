// Embedding providers (ADR 0006). The server owns exactly ONE embedding model as
// infrastructure so every Fact in a Namespace shares one vector space. Providers
// are pluggable at deploy time and pinned per Namespace. The interface takes a
// `role` so asymmetric models work (query vs document embeddings).

export type EmbedRole = "doc" | "query";

export interface EmbeddingProvider {
  /** Stable model id, pinned onto a Namespace. */
  readonly name: string;
  readonly dim: number;
  embed(text: string, role: EmbedRole): Promise<number[]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Zero-dependency deterministic local embedder — the default so the system runs
 * offline with no model download. It is a DEV STUB: it captures lexical overlap
 * (identical text → identical vector, so dedup/corroboration are exercised), but
 * it is NOT semantic. For real semantic search, select a production provider
 * (Qwen3-Embedding-0.6B via @huggingface/transformers, or MiniMax below) — the
 * pipeline (pinning, dedup, brute-force retrieval) is identical either way.
 */
export class LocalHashEmbedder implements EmbeddingProvider {
  readonly name = "local-hash-v1";
  constructor(readonly dim = 256) {}

  async embed(text: string, _role: EmbedRole): Promise<number[]> {
    const v = new Array(this.dim).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
      const idx = Math.abs(h) % this.dim;
      const sign = (h & 1) ? 1 : -1;
      v[idx] += sign;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

/**
 * MiniMax `embo-01` (API, 1536-dim). Asymmetric: role `doc` -> type `db`,
 * `query` -> type `query`. Needs MINIMAX_API_KEY and MINIMAX_GROUP_ID.
 */
export class MiniMaxEmbedder implements EmbeddingProvider {
  readonly name = "minimax-embo-01";
  readonly dim = 1536;
  constructor(private apiKey: string, private groupId: string) {}

  async embed(text: string, role: EmbedRole): Promise<number[]> {
    const url = `https://api.minimax.chat/v1/embeddings?GroupId=${encodeURIComponent(this.groupId)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embo-01", texts: [text], type: role === "doc" ? "db" : "query" }),
    });
    if (!res.ok) throw new Error(`minimax embed failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    const vec = json.vectors?.[0];
    if (!Array.isArray(vec)) throw new Error("minimax embed: no vector in response");
    return vec;
  }
}

/**
 * Qwen3-Embedding-0.6B via Transformers.js (ONNX). The production local default:
 * private, offline after first download, 1024-dim. Asymmetric — queries get an
 * instruction prefix, documents are embedded raw. Uses last-token pooling +
 * normalization, per the model card. The model (~600MB, cached under
 * ~/.cache/huggingface) is downloaded lazily on first embed.
 */
export class QwenEmbedder implements EmbeddingProvider {
  readonly name = "qwen3-embedding-0.6b";
  readonly dim = 1024;
  private static TASK = "Given a query, retrieve relevant facts that answer it";
  private extractor: Promise<any> | null = null;

  constructor(private dtype: "fp32" | "fp16" | "q8" = (process.env.QWEN_DTYPE as any) ?? "q8") {}

  private pipe(): Promise<any> {
    if (!this.extractor) {
      this.extractor = import("@huggingface/transformers").then(({ pipeline }) =>
        pipeline("feature-extraction", "onnx-community/Qwen3-Embedding-0.6B-ONNX", { dtype: this.dtype }));
    }
    return this.extractor;
  }

  async embed(text: string, role: EmbedRole): Promise<number[]> {
    const input = role === "query" ? `Instruct: ${QwenEmbedder.TASK}\nQuery:${text}` : text;
    const extractor = await this.pipe();
    const out = await extractor(input, { pooling: "last_token", normalize: true });
    return out.tolist()[0] as number[];
  }
}

/** Select a provider from env. Default: Qwen (production local). */
export function providerFromEnv(): EmbeddingProvider {
  const which = (process.env.EMBED_PROVIDER ?? "qwen").toLowerCase();
  if (which === "local") return new LocalHashEmbedder();
  if (which === "minimax") {
    const key = process.env.MINIMAX_API_KEY, group = process.env.MINIMAX_GROUP_ID;
    if (!key || !group) throw new Error("EMBED_PROVIDER=minimax requires MINIMAX_API_KEY and MINIMAX_GROUP_ID");
    return new MiniMaxEmbedder(key, group);
  }
  return new QwenEmbedder();
}
