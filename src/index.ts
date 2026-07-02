import { openDb } from "./db.js";
import { Store } from "./store.js";
import { LockManager } from "./lockManager.js";
import { FactStore } from "./factStore.js";
import { providerFromEnv } from "./embeddings.js";
import { startServer } from "./server.js";

const DB_PATH = process.env.DB_PATH ?? "thoughtful.db";
const PORT = Number(process.env.PORT ?? 8787);

const db = await openDb(DB_PATH);

// In-memory lock state didn't survive a restart; any claim still marked granted
// in the durable mirror is stale (ADR 0003 — rehydrate + let leases lapse). For
// v1 we simply retire them so the viz doesn't show phantom locks.
await db.prepare(`UPDATE claims SET status = 'expired' WHERE status = 'granted'`).run();

const store = await Store.create(db);

// Recovery sweep: MCP sessions are in-memory, so no agent survived the restart.
// Mark lingering agents as left and end any still-'active' Runs — otherwise they
// stay active forever (the disconnect-driven auto-end can never fire for them).
const staleRuns = (await db.prepare(`SELECT id FROM runs WHERE status = 'active'`).all()) as { id: string }[];
await db.prepare(`UPDATE agents SET left_at = ? WHERE left_at IS NULL`).run(Date.now());
for (const r of staleRuns) {
  store.journal(r.id, null, "run.ended", null, { reason: "server restarted" });
  store.endRun(r.id);
}
if (staleRuns.length) console.log(`thoughtful: recovery — ended ${staleRuns.length} run(s) orphaned by restart`);
const lock = new LockManager(db, store);
const embed = providerFromEnv();
const facts = new FactStore(db, store, embed);
console.log(`thoughtful: embedding provider = ${embed.name} (dim ${embed.dim})`);

startServer({ store, lock, facts }, PORT);
