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
const lock = new LockManager(db, store);
const embed = providerFromEnv();
const facts = new FactStore(db, store, embed);
console.log(`thoughtful: embedding provider = ${embed.name} (dim ${embed.dim})`);

startServer({ store, lock, facts }, PORT);
