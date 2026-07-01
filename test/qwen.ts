// Real Qwen embedder probe — downloads the ONNX model on first run (~600MB,
// cached), embeds a few texts, and checks dimension + that semantically-related
// text scores higher than unrelated text. NOT part of `npm test` (needs network
// + disk). Run: npx tsx test/qwen.ts
import { QwenEmbedder, cosine } from "../src/embeddings.js";

let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failures++; };

async function main() {
  const e = new QwenEmbedder();
  console.log(`loading ${e.name} (dtype q8) — first run downloads the model…`);

  const doc = await e.embed("The authentication service issues JWT tokens for login.", "doc");
  ok(doc.length === e.dim, `doc embedding has dim ${e.dim} (got ${doc.length})`);

  const q = await e.embed("How does login authentication work?", "query");
  const unrelated = await e.embed("Tomatoes grow well in warm soil.", "doc");

  const simRelated = cosine(q, doc);
  const simUnrelated = cosine(q, unrelated);
  console.log(`  cosine(query, related doc)   = ${simRelated.toFixed(4)}`);
  console.log(`  cosine(query, unrelated doc) = ${simUnrelated.toFixed(4)}`);
  ok(simRelated > simUnrelated, `related > unrelated (semantic signal present)`);
  ok(simRelated > 0.4, `related similarity is meaningfully high`);

  console.log(failures === 0 ? "\nQWEN OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
