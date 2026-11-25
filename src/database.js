import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertSupportedSchema } from "./schema.js";

const cachedReadDatabases = new Map();

export function openSourceDatabase(databasePath) {
  if (!existsSync(databasePath)) {
    throw new Error(`source database does not exist: ${databasePath}`);
  }

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assertSupportedSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function databaseFingerprint(databasePath) {
  const stats = statSync(databasePath, { bigint: true });
  return [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mtimeNs,
  ].join(":");
}

export function getCachedSourceDatabase(databasePath) {
  const path = resolve(databasePath);
  if (!existsSync(path)) return openSourceDatabase(path);
  const fingerprint = databaseFingerprint(path);
  const cached = cachedReadDatabases.get(path);
  if (cached?.fingerprint === fingerprint) {
    return cached.db;
  }
  if (cached) cached.db.close();

  const db = openSourceDatabase(path);
  cachedReadDatabases.set(path, { db, fingerprint });
  return db;
}

export function invalidateSourceDatabase(databasePath) {
  const path = resolve(databasePath);
  const cached = cachedReadDatabases.get(path);
  if (!cached) return false;
  cached.db.close();
  cachedReadDatabases.delete(path);
  return true;
}

export function closeCachedSourceDatabases() {
  for (const cached of cachedReadDatabases.values()) {
    cached.db.close();
  }
  cachedReadDatabases.clear();
}

