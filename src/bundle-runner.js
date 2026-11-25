import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { getCachedSourceDatabase } from "./database.js";

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

export async function runBundleEntry(options) {
  const db = getCachedSourceDatabase(options.databasePath);
  let version;
  let assets;
  version = bundleVersion(db, options.moduleKey, options.version);
  if (!version) {
    throw new Error(
      options.version
        ? `bundle version not found: ${options.moduleKey}@${options.version}`
        : `bundle module has no head version: ${options.moduleKey}`,
    );
  }
  assets = db
    .prepare(
      "SELECT path, content, mode FROM module_assets WHERE module_version_id = ? ORDER BY path",
    )
    .all(version.id);
  if (assets.length === 0) {
    throw new Error(`module is a source module, not a runnable bundle: ${options.moduleKey}`);
  }
  if (!assets.some((asset) => asset.path === options.entryPath)) {
    throw new Error(
      `bundle entry not found: ${options.moduleKey}/${options.entryPath}`,
    );
  }

  const root = mkdtempSync(join(tmpdir(), "jsinsqlite-bundle-"));
  try {
    const entry = extractBundle(root, options.entryPath, assets);
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
    return { code, signal, root, version };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
