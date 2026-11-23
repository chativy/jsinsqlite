#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildDatabase } from "../src/build.js";
import { runBundledModule } from "../src/bundle-runner.js";
import { compileModuleFile } from "../src/compiler.js";
import { openSourceDatabase } from "../src/database.js";
import { importGitVersions } from "../src/git-importer.js";
import { importModuleDatabase } from "../src/importer.js";
import "../src/register.js";

const USAGE = `Usage:
  jsqlite build <manifest.json> <source.sqlite> [--force]
  jsqlite import <entry.ts> <source.sqlite> [module-key] [--force]
  jsqlite import-git <repo> <entry> <source.sqlite> [module-key] [--limit=5] [--history=path] [--force]
  jsqlite compile <source.sqlite> [module-key] [version]
  jsqlite versions <source.sqlite> [module-key]
  jsqlite run <source.sqlite> <module-key> <export> [--version=tag] [--args=json-array]
  jsqlite run-bundle <source.sqlite> <module-key> [--version=tag] [-- pi-arguments...]
  jsqlite run-pi-code <source.sqlite> --deepseek-key=key [-- pi-arguments...]

Module keys default to "main". Use --force to replace an existing database.`;

function requireArgument(args, index, name) {
  const value = args[index];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function optionValue(args, name) {
  const prefix = `--${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function requiredOptionValue(args, name) {
  const inline = optionValue(args, name);
  if (inline !== undefined && inline !== "") return inline;

  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return value;
}

async function runCommand(args) {
  const separator = args.indexOf("--");
  const forwardedArguments = separator === -1 ? [] : args.slice(separator + 1);
  if (separator !== -1) args = args.slice(0, separator);
  const command = args[0];

  if (command === "build") {
    const manifestPath = resolve(requireArgument(args, 1, "manifest path"));
    const databasePath = resolve(requireArgument(args, 2, "database path"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    buildDatabase(databasePath, manifest, {
      overwrite: args.includes("--force"),
    });
    console.log(`Built ${databasePath}`);
    return;
  }

  if (command === "compile") {
    const databasePath = resolve(requireArgument(args, 1, "database path"));
    const moduleKey = args[2] ?? "main";
    const version = args[3];
    process.stdout.write(
      `${compileModuleFile(databasePath, moduleKey, version)}\n`,
    );
    return;
  }

  if (command === "import") {
    const entryPath = resolve(requireArgument(args, 1, "entry path"));
    const databasePath = resolve(requireArgument(args, 2, "database path"));
    const moduleKey = args[3]?.startsWith("--") ? undefined : args[3];
    const graph = importModuleDatabase({
      entryPath,
      databasePath,
      moduleKey,
      overwrite: args.includes("--force"),
    });

    console.log(
      `Built ${databasePath} with ${graph.manifest.modules.length} module(s)`,
    );
    if (graph.packageImports.length > 0) {
      console.log(
        `Runtime package imports left external: ${graph.packageImports.join(", ")}`,
      );
    }
    return;
  }

  if (command === "import-git") {
    const repositoryPath = resolve(requireArgument(args, 1, "repository path"));
    const entryPath = requireArgument(args, 2, "entry path");
    const databasePath = resolve(requireArgument(args, 3, "database path"));
    const moduleKey = args[4]?.startsWith("--") ? undefined : args[4];
    const limitValue = optionValue(args, "limit");
    const limit = limitValue === undefined ? 5 : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("--limit must be a positive integer");
    }

    const graph = importGitVersions({
      repositoryPath,
      entryPath,
      databasePath,
      moduleKey,
      historyPath: optionValue(args, "history"),
      limit,
      overwrite: args.includes("--force"),
    });

    console.log(
      `Built ${databasePath} with ${graph.versions.length} version(s) across ${graph.manifest.modules.length} module(s)`,
    );
    for (const version of graph.versions) {
      console.log(`${version.version}\t${version.sourceRevision}`);
    }
    if (graph.packageImports.length > 0) {
      console.log(
        `Runtime package imports left external: ${graph.packageImports.join(", ")}`,
      );
    }
    return;
  }

  if (command === "versions") {
    const databasePath = resolve(requireArgument(args, 1, "database path"));
    const moduleKey = args[2];
    const db = openSourceDatabase(databasePath);
    try {
      const rows = db
        .prepare(
          `
            SELECT modules.key AS module, module_versions.version,
                   module_versions.tag, module_versions.source_revision,
                   module_versions.created_at
            FROM modules
            JOIN module_versions ON module_versions.module_id = modules.id
            WHERE (? IS NULL OR modules.key = ?)
            ORDER BY modules.key, module_versions.created_at DESC
          `,
        )
        .all(moduleKey ?? null, moduleKey ?? null);
      for (const row of rows) {
        console.log(
          `${row.module}\t${row.version}\t${row.tag}\t${row.source_revision}\t${row.created_at}`,
        );
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === "run") {
    const databasePath = resolve(requireArgument(args, 1, "database path"));
    const moduleKey = requireArgument(args, 2, "module key");
    const exportName = requireArgument(args, 3, "export name");
    const version = optionValue(args, "version");
    const rawArguments = optionValue(args, "args") ?? "[]";
    const callArguments = JSON.parse(rawArguments);
    if (!Array.isArray(callArguments)) {
      throw new Error("--args must be a JSON array");
    }

    const url = pathToFileURL(databasePath);
    url.searchParams.set("module", moduleKey);
    if (version !== undefined) url.searchParams.set("version", version);
    url.searchParams.set("run", `${process.pid}-${Date.now()}`);
    const loaded = await import(url.href);
    const entry = loaded[exportName];
    if (typeof entry !== "function") {
      throw new Error(`module ${moduleKey} has no callable export ${exportName}`);
    }

    const result = await entry(...callArguments);
    if (result !== undefined) console.log(result);
    return;
  }

  if (command === "run-bundle") {
    const databasePath = resolve(requireArgument(args, 1, "database path"));
    const moduleKey = requireArgument(args, 2, "module key");
    const result = await runBundledModule({
      databasePath,
      moduleKey,
      version: optionValue(args, "version"),
      arguments: forwardedArguments,
    });
    if (result.code !== null) process.exitCode = result.code;
    return;
  }

  if (command === "run-pi-code") {
    const databasePath = resolve(requireArgument(args, 1, "database path"));
    const deepseekKey =
      optionValue(args, "deepseek-key") ?? process.env.DEEPSEEK_API_KEY;
    if (!deepseekKey) {
      requiredOptionValue(args, "deepseek-key");
    }
    const result = await runBundledModule({
      databasePath,
      moduleKey: "pi-code",
      version: optionValue(args, "version"),
      arguments: forwardedArguments,
      env: {
        DEEPSEEK_API_KEY: deepseekKey,
      },
    });
    if (result.code !== null) process.exitCode = result.code;
    return;
  }

  throw new Error(USAGE);
}

try {
  await runCommand(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

