import {
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import {
  basename,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { buildDatabase } from "./build.js";

function archivePath(path) {
  return path.split(sep).join("/");
}

export function collectBundlePath(files, sourcePath, targetPath = basename(sourcePath)) {
  const absolute = resolve(sourcePath);
  const details = lstatSync(absolute);

  if (details.isDirectory()) {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      collectBundlePath(
        files,
        join(absolute, entry.name),
        posix.join(targetPath, entry.name),
      );
    }
    return;
  }
  if (!details.isFile()) {
    throw new Error(`bundle path is not a regular file or directory: ${sourcePath}`);
  }

  const path = archivePath(targetPath);
  if (files.some((file) => file.path === path)) {
    throw new Error(`duplicate bundle path: ${path}`);
  }
  files.push({
    path,
    content: readFileSync(absolute),
    mode: details.mode & 0o777,
  });
}

export function collectBundleDirectory(
  files,
  sourceDirectory,
  options = {},
) {
  const root = resolve(sourceDirectory);
  const excludedDirectories = new Set(
    options.excludedDirectories ?? [".git", "node_modules/.cache"],
  );
  const excludedFiles = new Set(
    (options.excludedFiles ?? []).map((path) => resolve(path)),
  );

  function visit(absolute, archivePath) {
    if (excludedFiles.has(absolute)) return;
    const details = lstatSync(absolute);
    if (details.isSymbolicLink()) return;
    if (details.isDirectory()) {
      if (archivePath && excludedDirectories.has(archivePath)) return;
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        visit(
          join(absolute, entry.name),
          posix.join(archivePath, entry.name),
        );
      }
      return;
    }
    if (!details.isFile()) return;

    files.push({
      path: archivePath,
      content: readFileSync(absolute),
      mode: details.mode & 0o777,
    });
  }

  visit(root, "");
  return files;
}

export function importBundleDatabase(options) {
  const files = options.files;
  const entryPath = archivePath(options.entryPath);
  if (!files.some((file) => file.path === entryPath)) {
    throw new Error(`bundle entry is not in the file set: ${entryPath}`);
  }

  const manifest = {
    modules: [
      {
        key: options.moduleKey,
        description: options.description ?? `Bundled from ${options.sourcePath ?? entryPath}`,
        versions: [
          {
            version: options.version,
            tag: options.tag,
            sourceRevision: options.sourceRevision,
            createdAt: options.createdAt,
            format: "js",
            sourcePath: entryPath,
            entries: [
              {
                key: "main",
                kind: "module",
                source: `export const bundleEntry = ${JSON.stringify(entryPath)};`,
              },
            ],
            assets: files.map((file) => ({
              path: file.path,
              content: file.content,
              mode: file.mode,
            })),
          },
        ],
      },
    ],
  };

  buildDatabase(options.databasePath, manifest, {
    overwrite: options.overwrite,
  });
  return {
    manifest,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.content.length, 0),
  };
}

export function relativeArchivePath(root, path) {
  return archivePath(relative(root, path));
}
