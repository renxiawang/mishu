/**
 * Shared parsing primitives for coding backends — the agent-AGNOSTIC scaffolding
 * every backend needs to read its CLI's captured bytes. These carry NO agent
 * format knowledge (no event schema, no rollout/transcript naming): that stays
 * in each backend (§3/§4.9). A backend layers its agent-specific interpretation
 * on top (which JSON fields mean what, which glob/regex names a session file).
 */

/** True for any non-null object (the precondition for safely indexing parsed JSON). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A value as a string, or null if it isn't one. */
export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parse a JSONL stream into raw events for log enrichment (skip non-JSON lines). */
export function parseJsonlEvents(captured: string): unknown[] {
  const events: unknown[] = [];
  for (const line of captured.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip non-JSON progress lines
    }
  }
  return events;
}

/** From `find … -printf '%T@\t%p\n'` output, the path with the greatest mtime. */
export function newestByMtime(findOutput: string): string | null {
  let bestPath: string | null = null;
  let bestMtime = Number.NEGATIVE_INFINITY;
  for (const line of findOutput.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const mtime = Number.parseFloat(line.slice(0, tab));
    if (Number.isFinite(mtime) && mtime > bestMtime) {
      bestMtime = mtime;
      bestPath = line.slice(tab + 1);
    }
  }
  return bestPath;
}
