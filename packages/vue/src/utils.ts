import type { ChangeEvent, ListMeta } from "@loomup/client";

/** Stable serialization for watch sources (order-insensitive where keys). */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k];
      }
      return sorted;
    }
    return v;
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type SelectOptions = {
  where?: Record<string, string | number | boolean>;
  sort?: string;
  limit?: number;
  offset?: number;
};

export type LiveStrategy = "merge" | "refetch";

/**
 * Extract a string row id from a change event or row object.
 * Prefers event.id, then primaryKey field, then conventional "id".
 */
export function rowIdFrom(
  row: Record<string, unknown> | undefined,
  eventId?: string,
  primaryKey = "id",
): string | undefined {
  if (eventId !== undefined && eventId !== "") return String(eventId);
  if (!row) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, primaryKey)) {
    const raw = row[primaryKey];
    if (raw !== undefined && raw !== null) return String(raw);
  }
  if (Object.prototype.hasOwnProperty.call(row, "id")) {
    const raw = row["id"];
    if (raw !== undefined && raw !== null) return String(raw);
  }
  return undefined;
}

/**
 * Apply a change event to a local row list (best-effort merge).
 * Does not re-evaluate server-side where/rules — use strategy "refetch" when filters matter.
 */
export function applyChangeToRows<T extends Record<string, unknown>>(
  rows: T[],
  event: ChangeEvent,
  primaryKey = "id",
): T[] {
  const op = String(event.op || "").toUpperCase();
  const id = rowIdFrom(
    event.data as Record<string, unknown> | undefined,
    event.id,
    primaryKey,
  );

  if (op === "DELETE") {
    if (!id) return rows;
    return rows.filter(
      (r) => rowIdFrom(r as Record<string, unknown>, undefined, primaryKey) !== id,
    );
  }

  if (op === "INSERT" || op === "UPDATE" || op === "RESYNC") {
    if (!event.data || typeof event.data !== "object") {
      // No payload — leave list unchanged (caller may refetch).
      return rows;
    }
    const next = event.data as T;
    const nextId = rowIdFrom(next as Record<string, unknown>, id, primaryKey);
    if (!nextId) return rows;
    const idx = rows.findIndex(
      (r) =>
        rowIdFrom(r as Record<string, unknown>, undefined, primaryKey) === nextId,
    );
    if (idx === -1) {
      return [...rows, next];
    }
    const copy = rows.slice();
    copy[idx] = next;
    return copy;
  }

  return rows;
}

export type QueryResultMeta = ListMeta | null;
