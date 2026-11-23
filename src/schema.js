import { SCHEMA_VERSION } from "./constants.js";

const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE jsqlite_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE modules (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT ''
  ) STRICT;

  CREATE TABLE module_versions (
    id INTEGER PRIMARY KEY,
    module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    tag TEXT NOT NULL DEFAULT '',
    source_revision TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'js' CHECK (format IN ('js', 'ts')),
    source_path TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (module_id, version)
  ) STRICT;

  CREATE TABLE module_heads (
    module_id INTEGER PRIMARY KEY REFERENCES modules(id) ON DELETE CASCADE,
    module_version_id INTEGER NOT NULL UNIQUE
      REFERENCES module_versions(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    module_version_id INTEGER NOT NULL REFERENCES module_versions(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (length(kind) > 0),
    source TEXT NOT NULL,
    UNIQUE (module_version_id, key)
  ) STRICT;

  CREATE UNIQUE INDEX entries_one_module_root
    ON entries(module_version_id)
    WHERE kind = 'module';

  CREATE TABLE entry_refs (
    from_entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK (slot >= 0),
    to_entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE RESTRICT,
    PRIMARY KEY (from_entry_id, slot)
  ) STRICT;

  CREATE INDEX entry_refs_to_entry
    ON entry_refs(to_entry_id);

  INSERT INTO jsqlite_meta(key, value)
  VALUES ('schema_version', '${SCHEMA_VERSION}');

  PRAGMA user_version = ${SCHEMA_VERSION};
`;

export function initializeSchema(db) {
  db.exec(SCHEMA_SQL);
}

export function assertSupportedSchema(db) {
  const row = db
    .prepare("SELECT value FROM jsqlite_meta WHERE key = 'schema_version'")
    .get();
  const version = Number(row?.value);

  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported jsqlite schema version: expected ${SCHEMA_VERSION}, got ${row?.value ?? "none"}`,
    );
  }
}

