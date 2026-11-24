import { SCHEMA_VERSION } from "./constants.js";

const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE jsinsqlite_meta (
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

  CREATE TABLE module_assets (
    module_version_id INTEGER NOT NULL
      REFERENCES module_versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content BLOB NOT NULL,
    mode INTEGER NOT NULL DEFAULT 420,
    PRIMARY KEY (module_version_id, path)
  ) STRICT;

  CREATE TABLE version_entrypoints (
    module_version_id INTEGER NOT NULL
      REFERENCES module_versions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('asset', 'export')),
    target TEXT NOT NULL,
    PRIMARY KEY (module_version_id, name)
  ) STRICT;

  CREATE INDEX version_entrypoints_name
    ON version_entrypoints(name);

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

  INSERT INTO jsinsqlite_meta(key, value)
  VALUES ('schema_version', '${SCHEMA_VERSION}');

  PRAGMA user_version = ${SCHEMA_VERSION};
`;

export function initializeSchema(db) {
  db.exec(SCHEMA_SQL);
}

export function assertSupportedSchema(db) {
  const row = db
    .prepare("SELECT value FROM jsinsqlite_meta WHERE key = 'schema_version'")
    .get();
  const version = Number(row?.value);

  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported jsinsqlite schema version: expected ${SCHEMA_VERSION}, got ${row?.value ?? "none"}`,
    );
  }
}

