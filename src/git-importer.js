import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { buildDatabase } from "./build.js";
import {
  collectModuleGraph,
  localRuntimeImports,
  mergeModuleGraphs,
} from "./importer.js";

function runGit(repositoryPath, args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.error}`,
    );
  }
  return result;
}

function repositoryPath(relativePath) {
  return relativePath.split(sep).join("/");
}

function gitPathExists(repository, revision, path) {
  return (
    runGit(repository, ["cat-file", "-e", `${revision}:${path}`], true)
      .status === 0
  );
}

function readGitFile(repository, revision, path) {
  return runGit(repository, ["show", `${revision}:${path}`]).stdout;
}

function resolveGitImport(repository, revision, importerPath, specifier) {
  const base = posix.normalize(
    posix.join(posix.dirname(importerPath), specifier),
  );
  if (base === ".." || base.startsWith("../")) {
    throw new Error(
      `local import escapes the repository: ${specifier} from ${importerPath}`,
    );
  }

  const extension = posix.extname(base);
  const withoutExtension = extension
    ? base.slice(0, -extension.length)
    : base;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.jsx`,
    posix.join(base, "index.ts"),
    posix.join(base, "index.js"),
  ];
  if ([".js", ".mjs", ".jsx"].includes(extension)) {
    candidates.unshift(`${withoutExtension}.ts`, `${withoutExtension}.tsx`);
  }

  const found = candidates.find((candidate) =>
    gitPathExists(repository, revision, candidate),
  );
  if (!found) {
    throw new Error(
      `cannot resolve ${specifier} from ${importerPath} at ${revision}`,
    );
  }
  return found;
}

function collectSnapshotFiles(repository, revision, entryPath) {
  const files = new Map();
  const pending = [entryPath];

  while (pending.length > 0) {
    const path = pending.shift();
    if (files.has(path)) continue;

    const source = readGitFile(repository, revision, path);
    files.set(path, source);
    for (const specifier of localRuntimeImports(source, path)) {
      const dependency = resolveGitImport(
        repository,
        revision,
        path,
        specifier,
      );
      if (!files.has(dependency)) pending.push(dependency);
    }
  }

  return files;
}

function materializeSnapshot(files) {
  const directory = mkdtempSync(join(tmpdir(), "jsqlite-git-"));
  for (const [path, source] of files) {
    const target = join(directory, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return directory;
}

function versionNotation(repository, revision) {
  const shortRevision = runGit(repository, [
    "rev-parse",
    "--short=9",
    revision,
  ]).stdout.trim();
  const exactTag = runGit(repository, ["tag", "--points-at", revision]).stdout
    .split("\n")
    .map((tag) => tag.trim())
    .find(Boolean);
  const describe = runGit(
    repository,
    ["describe", "--tags", "--abbrev=0", revision],
    true,
  );
  const tag = describe.status === 0 ? describe.stdout.trim() : "";

  return {
    version: exactTag ?? (tag ? `${tag}+${shortRevision}` : shortRevision),
    tag,
    sourceRevision: revision,
  };
}

export function collectGitVersions(options) {
  const repository = resolve(options.repositoryPath);
  const absoluteEntry = resolve(repository, options.entryPath);
  const entryPath = repositoryPath(relative(repository, absoluteEntry));
  if (entryPath === ".." || entryPath.startsWith("../")) {
    throw new Error(`entry must be inside the repository: ${options.entryPath}`);
  }

  const historyPath = options.historyPath ?? dirname(entryPath);
  const limit = options.limit ?? 5;
  const revisions = runGit(repository, [
    "log",
    `-n`,
    `${limit * 5}`,
    "--format=%H%x09%cI",
    "--",
    historyPath,
  ])
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([revision]) => gitPathExists(repository, revision, entryPath))
    .slice(0, limit);

  if (revisions.length === 0) {
    throw new Error(
      `no Git revisions contain ${entryPath} under ${historyPath}`,
    );
  }

  const graphs = [];
  const versions = [];
  const packageImports = new Set();

  for (const [revision, createdAt] of revisions) {
    const notation = versionNotation(repository, revision);
    const snapshotDirectory = materializeSnapshot(
      collectSnapshotFiles(repository, revision, entryPath),
    );
    try {
      const graph = collectModuleGraph(
        join(snapshotDirectory, ...entryPath.split("/")),
        {
          moduleKey:
            options.moduleKey ?? posix.basename(entryPath, extname(entryPath)),
          ...notation,
          createdAt,
        },
      );
      graphs.push(graph);
      versions.push(notation);
      for (const specifier of graph.packageImports) {
        packageImports.add(specifier);
      }
    } finally {
      rmSync(snapshotDirectory, { recursive: true, force: true });
    }
  }

  return {
    manifest: mergeModuleGraphs(graphs),
    versions,
    packageImports: [...packageImports].sort(),
  };
}

export function importGitVersions(options) {
  const graph = collectGitVersions(options);
  buildDatabase(options.databasePath, graph.manifest, {
    overwrite: options.overwrite,
  });
  return graph;
}
