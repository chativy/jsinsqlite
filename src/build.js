import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT_ENTRY_KEY, ROOT_ENTRY_KIND } from "./constants.js";
import { initializeSchema } from "./schema.js";

const ENTRY_KINDS = new Set([
  "module",
  "class",
  "function",
  "method",
  "constant",
  "statement",
  "snippet",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, path) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

export function validateManifest(input) {
  if (!isPlainObject(input) || !Array.isArray(input.modules)) {
    throw new Error("manifest.modules must be an array");
  }
  if (input.modules.length === 0) {
    throw new Error("manifest must contain at least one module");
  }

  const moduleKeys = new Set();
  const modules = input.modules.map((rawModule, moduleIndex) => {
    const modulePath = `manifest.modules[${moduleIndex}]`;
    if (!isPlainObject(rawModule)) {
      throw new Error(`${modulePath} must be an object`);
    }

    const key = requireString(rawModule.key, `${modulePath}.key`);
    if (moduleKeys.has(key)) {
      throw new Error(`duplicate module key: ${key}`);
    }
    moduleKeys.add(key);

    if (!Array.isArray(rawModule.entries) || rawModule.entries.length === 0) {
      throw new Error(`${modulePath}.entries must be a non-empty array`);
    }

    const entryKeys = new Set();
    const entries = rawModule.entries.map((rawEntry, entryIndex) => {
      const entryPath = `${modulePath}.entries[${entryIndex}]`;
      if (!isPlainObject(rawEntry)) {
        throw new Error(`${entryPath} must be an object`);
      }

      const entryKey = requireString(rawEntry.key, `${entryPath}.key`);
      if (entryKeys.has(entryKey)) {
        throw new Error(`duplicate entry key in module ${key}: ${entryKey}`);
      }
      entryKeys.add(entryKey);

      const kind = requireString(rawEntry.kind, `${entryPath}.kind`);
      if (!ENTRY_KINDS.has(kind)) {
        throw new Error(
          `${entryPath}.kind must be one of: ${[...ENTRY_KINDS].join(", ")}`,
        );
      }

      const source = optionalString(rawEntry.source, `${entryPath}.source`);
      const rawRefs = rawEntry.refs ?? [];
      if (!Array.isArray(rawRefs)) {
        throw new Error(`${entryPath}.refs must be an array`);
      }

      const slots = new Set();
      const refs = rawRefs.map((rawRef, refIndex) => {
        const refPath = `${entryPath}.refs[${refIndex}]`;
        if (!isPlainObject(rawRef)) {
          throw new Error(`${refPath} must be an object`);
        }
        if (!Number.isSafeInteger(rawRef.slot) || rawRef.slot < 0) {
          throw new Error(`${refPath}.slot must be a non-negative integer`);
        }
        if (slots.has(rawRef.slot)) {
          throw new Error(
            `${entryPath} has more than one ref for slot ${rawRef.slot}`,
          );
        }
        slots.add(rawRef.slot);

        return {
          slot: rawRef.slot,
          entry: requireString(rawRef.entry, `${refPath}.entry`),
        };
      });

      return { key: entryKey, kind, source, refs };
    });

    const roots = entries.filter((entry) => entry.kind === ROOT_ENTRY_KIND);
    if (roots.length !== 1 || roots[0].key !== ROOT_ENTRY_KEY) {
      throw new Error(
        `${modulePath} must contain exactly one kind='${ROOT_ENTRY_KIND}' entry named '${ROOT_ENTRY_KEY}'`,
      );
    }

    for (const entry of entries) {
      for (const ref of entry.refs) {
        if (!entryKeys.has(ref.entry)) {
          throw new Error(
            `entry ${key}/${entry.key} references missing entry ${key}/${ref.entry}`,
          );
        }
      }
    }

    return {
      key,
      description: optionalString(rawModule.description, `${modulePath}.description`),
      entries,
    };
  });

  return { modules };
}

function temporaryDatabasePath(databasePath) {
  const extension = extname(databasePath);
  const suffix = `${process.pid}-${Date.now()}`;
  return join(
    dirname(databasePath),
    `.${basename(databasePath, extension)}.${suffix}.tmp`,
  );
}

function writeValidatedManifest(db, manifest) {
  const insertModule = db.prepare(
    "INSERT INTO modules(key, description) VALUES (?, ?)",
  );
  const insertEntry = db.prepare(
    "INSERT INTO entries(module_id, key, kind, source) VALUES (?, ?, ?, ?)",
  );
  const insertRef = db.prepare(
    "INSERT INTO entry_refs(from_entry_id, slot, to_entry_id) VALUES (?, ?, ?)",
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const module of manifest.modules) {
      const moduleResult = insertModule.run(module.key, module.description);
      const moduleId = Number(moduleResult.lastInsertRowid);
      const entryIds = new Map();

      for (const entry of module.entries) {
        const entryResult = insertEntry.run(
          moduleId,
          entry.key,
          entry.kind,
          entry.source,
        );
        entryIds.set(entry.key, Number(entryResult.lastInsertRowid));
      }

      for (const entry of module.entries) {
        for (const ref of entry.refs) {
          insertRef.run(
            entryIds.get(entry.key),
            ref.slot,
            entryIds.get(ref.entry),
          );
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function buildDatabase(databasePath, rawManifest, options = {}) {
  const manifest = validateManifest(rawManifest);
  const overwrite = options.overwrite === true;

  if (existsSync(databasePath) && !overwrite) {
    throw new Error(
      `database already exists: ${databasePath}; pass overwrite: true to replace it`,
    );
  }

  mkdirSync(dirname(databasePath), { recursive: true });
  const temporaryPath = temporaryDatabasePath(databasePath);

  try {
    const db = new DatabaseSync(temporaryPath);
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
      `);
      initializeSchema(db);
      writeValidatedManifest(db, manifest);
    } finally {
      db.close();
    }

    renameSync(temporaryPath, databasePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

