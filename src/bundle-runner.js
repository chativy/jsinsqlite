import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { getCachedSourceDatabase } from "./database.js";

const CACHE_FORMAT = 1;
const CACHE_MARKER = ".jsinsqlite-cache.json";

function bundleVersion(db, moduleKey, requestedVersion) {
  const module = db
    .prepare("SELECT id FROM modules WHERE key = ?")
    .get(moduleKey);
  if (!module) throw new Error(`source module not found: ${moduleKey}`);

  return requestedVersion
    ? db
        .prepare(
          `
            SELECT id, version, tag, source_revision, source_path, content_hash
            FROM module_versions
            WHERE module_id = ? AND version = ?
          `,
        )
        .get(module.id, requestedVersion)
    : db
        .prepare(
          `
            SELECT module_versions.id, module_versions.version,
                   module_versions.tag, module_versions.source_revision,
                   module_versions.source_path, module_versions.content_hash
            FROM module_heads
            JOIN module_versions
              ON module_versions.id = module_heads.module_version_id
            WHERE module_heads.module_id = ?
          `,
        )
        .get(module.id);
}

function extractBundle(root, entryPath, assets) {
  for (const asset of assets) {
    const target = resolve(root, ...asset.path.split("/"));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`bundle asset escapes the extraction root: ${asset.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, asset.content, { mode: asset.mode });
    chmodSync(target, asset.mode);
  }

  const entry = resolve(root, ...entryPath.split("/"));
  if (!entry.startsWith(`${root}${sep}`)) {
    throw new Error(`bundle entry escapes the extraction root: ${entryPath}`);
  }
  return entry;
}

function cacheRoot(options) {
  return resolve(
    options.cacheDir ??
      process.env.JSINSQLITE_CACHE_DIR ??
      join(homedir(), ".cache", "jsinsqlite"),
  );
}

function cacheKey(moduleKey, version, entryPath) {
  return createHash("sha256")
    .update(moduleKey)
    .update("\0")
    .update(version.version)
    .update("\0")
    .update(version.content_hash)
    .update("\0")
    .update(entryPath)
    .digest("hex");
}

function readCache(cachePath, key, entryPath) {
  const markerPath = join(cachePath, CACHE_MARKER);
  if (!existsSync(markerPath)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      marker.format !== CACHE_FORMAT ||
      marker.key !== key ||
      marker.entryPath !== entryPath
    ) {
      return undefined;
    }
    const entry = resolve(cachePath, ...entryPath.split("/"));
    if (!entry.startsWith(`${cachePath}${sep}`) || !existsSync(entry)) {
      return undefined;
    }
    return entry;
  } catch {
    return undefined;
  }
}

function writeCache(options) {
  const root = cacheRoot(options);
  const key = cacheKey(
    options.moduleKey,
    options.version,
    options.entryPath,
  );
  const cachePath = join(root, "assets", key);
  const cachedEntry = readCache(cachePath, key, options.entryPath);
  if (cachedEntry) {
    return { entry: cachedEntry, root: cachePath, cacheHit: true };
  }

  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  rmSync(cachePath, { recursive: true, force: true });
  const stagingPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    const entry = extractBundle(stagingPath, options.entryPath, options.assets);
    writeFileSync(
      join(stagingPath, CACHE_MARKER),
      JSON.stringify({
        format: CACHE_FORMAT,
        key,
        entryPath: options.entryPath,
        version: options.version.version,
        contentHash: options.version.content_hash,
        fileCount: options.assets.length,
        createdAt: new Date().toISOString(),
      }),
    );
    renameSync(stagingPath, cachePath);
    return {
      entry: resolve(cachePath, ...options.entryPath.split("/")),
      root: cachePath,
      cacheHit: false,
    };
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    const racedEntry = readCache(cachePath, key, options.entryPath);
    if (racedEntry) {
      return { entry: racedEntry, root: cachePath, cacheHit: true };
    }
    throw error;
  }
}

export async function runBundleEntry(options) {
  const db = getCachedSourceDatabase(options.databasePath);
  const version = bundleVersion(db, options.moduleKey, options.version);
  if (!version) {
    throw new Error(
      options.version
        ? `bundle version not found: ${options.moduleKey}@${options.version}`
        : `bundle module has no head version: ${options.moduleKey}`,
    );
  }

  let root;
  let entry;
  let cacheHit = false;
  let temporaryRoot = false;
  if (options.cache === false) {
    const assets = db
      .prepare(
        "SELECT path, content, mode FROM module_assets WHERE module_version_id = ? ORDER BY path",
      )
      .all(version.id);
    if (!assets.some((asset) => asset.path === options.entryPath)) {
      throw new Error(
        `bundle entry not found: ${options.moduleKey}/${options.entryPath}`,
      );
    }
    root = mkdtempSync(join(tmpdir(), "jsinsqlite-bundle-"));
    temporaryRoot = true;
    entry = extractBundle(root, options.entryPath, assets);
  } else {
    const key = cacheKey(
      options.moduleKey,
      version,
      options.entryPath,
    );
    const configuredRoot = cacheRoot(options);
    const cachePath = join(configuredRoot, "assets", key);
    const cachedEntry = readCache(cachePath, key, options.entryPath);
    if (cachedEntry) {
      root = cachePath;
      entry = cachedEntry;
      cacheHit = true;
    } else {
      const assets = db
        .prepare(
          "SELECT path, content, mode FROM module_assets WHERE module_version_id = ? ORDER BY path",
        )
        .all(version.id);
      if (!assets.some((asset) => asset.path === options.entryPath)) {
        throw new Error(
          `bundle entry not found: ${options.moduleKey}/${options.entryPath}`,
        );
      }
      const extracted = writeCache({
        ...options,
        version,
        assets,
      });
      root = extracted.root;
      entry = extracted.entry;
      cacheHit = extracted.cacheHit;
    }
  }

  try {
    const child = spawn(process.execPath, [entry, ...options.arguments], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        JSINSQLITE_BUNDLE_ROOT: root,
        ...options.env,
      },
      stdio: "inherit",
    });
    const [code, signal] = await once(child, "exit");
    return { code, signal, root, version, cacheHit };
  } finally {
    if (temporaryRoot) rmSync(root, { recursive: true, force: true });
  }
}
