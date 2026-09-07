import type { NativeDatabase } from "./types.js";

/**
 * Narrows an unknown database connection or client to NativeDatabase using structural guards.
 */
export function getNativeDatabase(database: unknown): NativeDatabase | null {
  if (typeof database !== "object" || database === null) {
    return null;
  }
  const candidate =
    "$client" in database ? (database as { $client: unknown }).$client : database;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "prepare" in candidate &&
    typeof (candidate as { prepare: unknown }).prepare === "function"
  ) {
    return candidate as NativeDatabase;
  }
  return null;
}
