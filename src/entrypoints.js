import { DatabaseSync } from "node:sqlite";
import {
  getCachedSourceDatabase,
  invalidateSourceDatabase,
} from "./database.js";

function selectedVersion(db, moduleKey, version) {
  const module = db
    .prepare("SELECT id, key FROM modules WHERE key = ?")
    .get(moduleKey);
  if (!module) throw new Error(`source module not found: ${moduleKey}`);

  const selected = version
    ? db
        .prepare(
          "SELECT id, version FROM module_versions WHERE module_id = ? AND version = ?",
        )
        .get(module.id, version)
    : db
        .prepare(
          `
            SELECT module_versions.id, module_versions.version
            FROM module_heads
            JOIN module_versions
              ON module_versions.id = module_heads.module_version_id
            WHERE module_heads.module_id = ?
          `,
        )
        .get(module.id);
  if (!selected) {
    throw new Error(
      `module version not found: ${moduleKey}${version ? `@${version}` : ""}`,
    );
  }
  return { ...module, versionId: selected.id, version: selected.version };
}

export function listEntrypoints(options) {
  const db = getCachedSourceDatabase(options.databasePath);
  return db
    .prepare(
      `
          SELECT modules.key AS module, module_versions.version,
                 version_entrypoints.name, version_entrypoints.kind,
                 version_entrypoints.target
          FROM version_entrypoints
          JOIN module_versions
            ON module_versions.id = version_entrypoints.module_version_id
          JOIN modules ON modules.id = module_versions.module_id
          WHERE (? IS NULL OR modules.key = ?)
            AND (? IS NULL OR module_versions.version = ?)
          ORDER BY modules.key, module_versions.created_at DESC,
                   version_entrypoints.name
      `,
    )
    .all(
      options.moduleKey ?? null,
      options.moduleKey ?? null,
      options.version ?? null,
      options.version ?? null,
    );
}

export function resolveEntrypoint(databasePath, name, version) {
  const db = getCachedSourceDatabase(databasePath);
  return db
    .prepare(
      `
          SELECT modules.key AS module, module_versions.id AS version_id,
                 module_versions.version, version_entrypoints.kind,
                 version_entrypoints.target
          FROM version_entrypoints
          JOIN module_versions
            ON module_versions.id = version_entrypoints.module_version_id
          JOIN modules ON modules.id = module_versions.module_id
          LEFT JOIN module_heads
            ON module_heads.module_id = modules.id
           AND module_heads.module_version_id = module_versions.id
          WHERE version_entrypoints.name = ?
            AND (
              (? IS NOT NULL AND module_versions.version = ?)
              OR (? IS NULL AND module_heads.module_id IS NOT NULL)
            )
          ORDER BY modules.key, module_versions.created_at DESC
      `,
    )
    .all(name, version ?? null, version ?? null, version ?? null);
}

export function setEntrypoint(options) {
  if (options.kind !== "asset" && options.kind !== "export") {
    throw new Error("entrypoint kind must be asset or export");
  }

  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    const target = selectedVersion(db, options.moduleKey, options.version);
    if (options.kind === "asset") {
      const asset = db
        .prepare(
          "SELECT 1 FROM module_assets WHERE module_version_id = ? AND path = ?",
        )
        .get(target.versionId, options.target);
      if (!asset) {
        throw new Error(
          `entrypoint asset not found: ${options.moduleKey}@${target.version}/${options.target}`,
        );
      }
    }

    db.prepare(
      `
        INSERT INTO version_entrypoints(
          module_version_id, name, kind, target
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(module_version_id, name) DO UPDATE
        SET kind = excluded.kind, target = excluded.target
      `,
    ).run(
      target.versionId,
      options.name,
      options.kind,
      options.target,
    );
    invalidateSourceDatabase(options.databasePath);
    return {
      module: options.moduleKey,
      version: target.version,
      name: options.name,
      kind: options.kind,
      target: options.target,
    };
  } finally {
    db.close();
  }
}

export function removeEntrypoint(options) {
  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    const target = selectedVersion(db, options.moduleKey, options.version);
    const result = db
      .prepare(
        "DELETE FROM version_entrypoints WHERE module_version_id = ? AND name = ?",
      )
      .run(target.versionId, options.name);
    if (result.changes === 0) {
      throw new Error(
        `entrypoint not found: ${options.name} in ${options.moduleKey}@${target.version}`,
      );
    }
    invalidateSourceDatabase(options.databasePath);
    return {
      module: options.moduleKey,
      version: target.version,
      name: options.name,
    };
  } finally {
    db.close();
  }
}
