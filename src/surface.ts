import type { Surface, ClaimMode } from "./types.js";

/**
 * Parse a canonical surface string into a Surface.
 *   "path:repo/src/auth/login.ts"  -> { kind: "path", key: "repo/src/auth/login.ts" }
 *   "entity:user:1234"             -> { kind: "entity", key: "user:1234" }
 * A bare string with no recognized prefix is treated as a path.
 */
export function parseSurface(s: string): Surface {
  if (s.startsWith("path:")) return { kind: "path", key: normalizePath(s.slice(5)) };
  if (s.startsWith("entity:")) return { kind: "entity", key: s.slice(7) };
  return { kind: "path", key: normalizePath(s) };
}

export function surfaceToString(s: Surface): string {
  return `${s.kind}:${s.key}`;
}

function normalizePath(p: string): string {
  // Strip leading/trailing slashes and collapse repeats so prefix math is clean.
  return p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

/**
 * Do two Surfaces overlap? Only ever computed within the same kind.
 * - path:   ancestor/descendant (segment-wise prefix) or equal.
 * - entity: exact match.
 * Cross-kind never overlaps.
 */
export function surfacesOverlap(a: Surface, b: Surface): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "entity") return a.key === b.key;
  return pathOverlap(a.key, b.key);
}

function pathOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const as = a.split("/");
  const bs = b.split("/");
  const shorter = as.length < bs.length ? as : bs;
  const longer = as.length < bs.length ? bs : as;
  // shorter is an ancestor of longer iff every one of its segments matches.
  return shorter.every((seg, i) => seg === longer[i]);
}

/**
 * Are two claim modes on overlapping surfaces compatible?
 * shared+shared -> compatible; anything involving exclusive -> conflict.
 */
export function modesCompatible(a: ClaimMode, b: ClaimMode): boolean {
  return a === "shared" && b === "shared";
}

/** Does `holder` cover `cell` for the purpose of an enforced write? */
export function surfaceCovers(holder: Surface, cell: Surface): boolean {
  if (holder.kind !== cell.kind) return false;
  if (holder.kind === "entity") return holder.key === cell.key;
  // path: holder must be an ancestor-or-equal of the cell.
  const hs = holder.key.split("/");
  const cs = cell.key.split("/");
  if (hs.length > cs.length) return false;
  return hs.every((seg, i) => seg === cs[i]);
}
