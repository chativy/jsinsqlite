import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT_ENTRY_KEY, ROOT_ENTRY_KIND } from "./constants.js";
import { initializeSchema } from "./schema.js";

const ENTRY_KINDS = new Set([
  "module",
  "class",
  "function",
  "method",
  "constant",
  "type",
  "statement",
  "snippet",
]);
const MODULE_FORMATS = new Set(["js", "ts"]);

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

function validateAsset(rawAsset, path) {
  if (!isPlainObject(rawAsset)) {
    throw new Error(`${path} must be an object`);
  }

  const assetPath = requireString(rawAsset.path, `${path}.path`).replaceAll(
    "\\",
    "/",
  );
  const normalized = posix.normalize(assetPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized) ||
    normalized.includes("\0")
  ) {
    throw new Error(`${path}.path must be a safe relative path`);
  }

  if (!(rawAsset.content instanceof Uint8Array)) {
    throw new Error(`${path}.content must be a Buffer or Uint8Array`);
  }
  const mode = rawAsset.mode ?? 0o644;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new Error(`${path}.mode must be a valid file mode`);
  }

  return {
    path: normalized,
    content: Buffer.from(rawAsset.content),
    mode,
  };
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

    const rawVersions = rawModule.versions ?? [
      {
        version: rawModule.version ?? "local",
        tag: rawModule.tag,
        sourceRevision: rawModule.sourceRevision,
        createdAt: rawModule.createdAt,
        format: rawModule.format,
        sourcePath: rawModule.sourcePath,
        entries: rawModule.entries,
      },
    ];
    if (!Array.isArray(rawVersions) || rawVersions.length === 0) {
      throw new Error(`${modulePath}.versions must be a non-empty array`);
    }

    const versionKeys = new Set();
    const versions = rawVersions.map((rawVersion, versionIndex) => {
      const versionPath = `${modulePath}.versions[${versionIndex}]`;
      if (!isPlainObject(rawVersion)) {
        throw new Error(`${versionPath} must be an object`);
      }

      const version = requireString(rawVersion.version, `${versionPath}.version`);
      if (versionKeys.has(version)) {
        throw new Error(`duplicate version in module ${key}: ${version}`);
      }
      versionKeys.add(version);

      if (
        !Array.isArray(rawVersion.entries) ||
        rawVersion.entries.length === 0
      ) {
        throw new Error(`${versionPath}.entries must be a non-empty array`);
      }

      const entryKeys = new Set();
      const entries = rawVersion.entries.map((rawEntry, entryIndex) => {
        const entryPath = `${versionPath}.entries[${entryIndex}]`;
        if (!isPlainObject(rawEntry)) {
          throw new Error(`${entryPath} must be an object`);
        }

        const entryKey = requireString(rawEntry.key, `${entryPath}.key`);
        if (entryKeys.has(entryKey)) {
          throw new Error(
            `duplicate entry key in module ${key}/${version}: ${entryKey}`,
          );
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
          `${versionPath} must contain exactly one kind='${ROOT_ENTRY_KIND}' entry named '${ROOT_ENTRY_KEY}'`,
        );
      }

      for (const entry of entries) {
        for (const ref of entry.refs) {
          if (!entryKeys.has(ref.entry)) {
            throw new Error(
              `entry ${key}/${version}/${entry.key} references missing entry ${key}/${version}/${ref.entry}`,
            );
          }
        }
      }

      const rawAssets = rawVersion.assets ?? [];
      if (!Array.isArray(rawAssets)) {
        throw new Error(`${versionPath}.assets must be an array`);
      }
      const assetPaths = new Set();
      const assets = rawAssets.map((rawAsset, assetIndex) => {
        const asset = validateAsset(
          rawAsset,
          `${versionPath}.assets[${assetIndex}]`,
        );
        if (assetPaths.has(asset.path)) {
          throw new Error(
            `duplicate asset path in module ${key}/${version}: ${asset.path}`,
          );
        }
        assetPaths.add(asset.path);
        return asset;
      });

      const format = rawVersion.format ?? "js";
      if (!MODULE_FORMATS.has(format)) {
        throw new Error(
          `${versionPath}.format must be one of: ${[...MODULE_FORMATS].join(", ")}`,
        );
      }

      const sourcePath = optionalString(
        rawVersion.sourcePath,
        `${versionPath}.sourcePath`,
      );
      const rawEntrypoints =
        rawVersion.entrypoints ??
        (assets.length > 0 && sourcePath
          ? [{ name: key, kind: "asset", target: sourcePath }]
          : []);
      if (!Array.isArray(rawEntrypoints)) {
        throw new Error(`${versionPath}.entrypoints must be an array`);
      }
      const entrypointNames = new Set();
      const entrypoints = rawEntrypoints.map((rawEntrypoint, index) => {
        const entrypointPath = `${versionPath}.entrypoints[${index}]`;
        if (!isPlainObject(rawEntrypoint)) {
          throw new Error(`${entrypointPath} must be an object`);
        }
        const name = requireString(
          rawEntrypoint.name,
          `${entrypointPath}.name`,
        );
        if (entrypointNames.has(name)) {
          throw new Error(
            `duplicate entrypoint name in module ${key}/${version}: ${name}`,
          );
        }
        entrypointNames.add(name);
        const kind = requireString(
          rawEntrypoint.kind,
          `${entrypointPath}.kind`,
        );
        if (kind !== "asset" && kind !== "export") {
          throw new Error(`${entrypointPath}.kind must be asset or export`);
        }
        const target = requireString(
          rawEntrypoint.target,
          `${entrypointPath}.target`,
        );
        if (kind === "asset" && !assetPaths.has(target)) {
          throw new Error(
            `${entrypointPath}.target is not an asset: ${target}`,
          );
        }
        return { name, kind, target };
      });

      return {
        version,
        tag: optionalString(rawVersion.tag, `${versionPath}.tag`),
        sourceRevision: optionalString(
          rawVersion.sourceRevision,
          `${versionPath}.sourceRevision`,
        ),
        createdAt: optionalString(
          rawVersion.createdAt,
          `${versionPath}.createdAt`,
        ),
        format,
        sourcePath,
        assets,
        entrypoints,
        entries,
      };
    });

    return {
      key,
      description: optionalString(rawModule.description, `${modulePath}.description`),
      versions,
    };
  });

  return { modules };
}

function contentHash(moduleKey, version) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        module: moduleKey,
        sourcePath: version.sourcePath,
        entries: version.entries,
        entrypoints: version.entrypoints,
        assets: version.assets.map((asset) => ({
          path: asset.path,
          mode: asset.mode,
          sha256: createHash("sha256").update(asset.content).digest("hex"),
        })),
      }),
    )
    .digest("hex");
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
  const insertVersion = db.prepare(
    `
      INSERT INTO module_versions(
        module_id, version, tag, source_revision, format, source_path,
        content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const insertHead = db.prepare(
    "INSERT INTO module_heads(module_id, module_version_id) VALUES (?, ?)",
  );
  const insertEntry = db.prepare(
    "INSERT INTO entries(module_version_id, key, kind, source) VALUES (?, ?, ?, ?)",
  );
  const insertRef = db.prepare(
    "INSERT INTO entry_refs(from_entry_id, slot, to_entry_id) VALUES (?, ?, ?)",
  );
  const insertAsset = db.prepare(
    `
      INSERT INTO module_assets(module_version_id, path, content, mode)
      VALUES (?, ?, ?, ?)
    `,
  );
  const insertEntrypoint = db.prepare(
    `
      INSERT INTO version_entrypoints(module_version_id, name, kind, target)
      VALUES (?, ?, ?, ?)
    `,
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const module of manifest.modules) {
      const moduleResult = insertModule.run(module.key, module.description);
      const moduleId = Number(moduleResult.lastInsertRowid);
      const versions = module.versions.map((version) => ({
        ...version,
        createdAt: version.createdAt || new Date().toISOString(),
      }));
      const latestVersion =
        versions.find((version) => version.latest) ??
        versions.reduce((latest, version) =>
          version.createdAt > latest.createdAt ? version : latest,
        );
      let latestVersionId;

      for (const version of versions) {
        const versionResult = insertVersion.run(
          moduleId,
          version.version,
          version.tag,
          version.sourceRevision,
          version.format,
          version.sourcePath,
          contentHash(module.key, version),
          version.createdAt,
        );
        const moduleVersionId = Number(versionResult.lastInsertRowid);
        if (version === latestVersion) latestVersionId = moduleVersionId;
        const entryIds = new Map();

        for (const entry of version.entries) {
          const entryResult = insertEntry.run(
            moduleVersionId,
            entry.key,
            entry.kind,
            entry.source,
          );
          entryIds.set(entry.key, Number(entryResult.lastInsertRowid));
        }

        for (const entry of version.entries) {
          for (const ref of entry.refs) {
            insertRef.run(
              entryIds.get(entry.key),
              ref.slot,
              entryIds.get(ref.entry),
            );
          }
        }
        for (const asset of version.assets) {
          insertAsset.run(
            moduleVersionId,
            asset.path,
            asset.content,
            asset.mode,
          );
        }
        for (const entrypoint of version.entrypoints) {
          insertEntrypoint.run(
            moduleVersionId,
            entrypoint.name,
            entrypoint.kind,
            entrypoint.target,
          );
        }
      }
      insertHead.run(moduleId, latestVersionId);
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

