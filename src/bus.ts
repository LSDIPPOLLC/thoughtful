import { EventEmitter } from "node:events";
import type { JournalEntry } from "./types.js";

/**
 * In-process event bus. The single-threaded event loop means subscribers see a
 * consistent stream with no locking (ADR 0005). The SSE viz endpoint subscribes
 * here; every journaled event is published as it happens — no polling, no Turso
 * pub/sub (which does not exist).
 */
class Bus extends EventEmitter {
  publishJournal(entry: JournalEntry) {
    this.emit("journal", entry);
    this.emit(`journal:${entry.run_id}`, entry);
  }

  /** A lock-state delta (claim granted/released/expired) for live viz refresh. */
  publishState(runId: string) {
    this.emit(`state:${runId}`, runId);
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);
