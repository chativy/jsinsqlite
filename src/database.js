import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertSupportedSchema } from "./schema.js";

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

