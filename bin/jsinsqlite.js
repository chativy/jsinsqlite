#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildDatabase } from "../src/build.js";
import { runBundleEntry } from "../src/bundle-runner.js";
import { compileModuleFile } from "../src/compiler.js";
import { openSourceDatabase } from "../src/database.js";
import {
  listEntrypoints,
  removeEntrypoint,
  resolveEntrypoint,
  setEntrypoint,
} from "../src/entrypoints.js";
import { importGitVersions } from "../src/git-importer.js";
import { importModuleDatabase } from "../src/importer.js";
import "../src/register.js";

const USAGE = `Usage:
  jsinsqlite build <manifest.json> <source.sqlite> [--force]
  jsinsqlite import <entry.ts> <source.sqlite> [module-key] [--force]
  jsinsqlite import --git <repo> <entry> <source.sqlite> [module-key] [--limit=5] [--history=path] [--force]
  jsinsqlite inspect versions <source.sqlite> [module-key]
  jsinsqlite inspect code <source.sqlite> <module-key> [version]
  jsinsqlite entrypoints list <source.sqlite> [module-key] [--version=tag]
  jsinsqlite entrypoints set <source.sqlite> <module-key> <name> --kind=asset|export --target=path-or-export [--version=tag]
  jsinsqlite entrypoints remove <source.sqlite> <module-key> <name> [--version=tag]
  jsinsqlite run <source.sqlite> <entrypoint> [--version=tag] [--cwd=path] [--env=NAME=VALUE]... [-- arguments...]
  jsinsqlite call <source.sqlite> <module-key> <export> [--version=tag] [--cwd=path] [--env=NAME=VALUE]... [-- arguments...]
  jsinsqlite exec <source.sqlite> <module-key> <entrypoint-path> [--version=tag] [--cwd=path] [--env=NAME=VALUE]... [-- arguments...]

Versions default to the module head.`;

function requireArgument(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function optionValue(args, name) {
  const prefix = `--${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function environmentOptions(args) {
  const environment = {};
  for (const argument of args) {
    if (!argument.startsWith("--env=")) continue;
    const assignment = argument.slice("--env=".length);
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new Error("--env must use NAME=VALUE");
    const name = assignment.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid environment variable name: ${name}`);
    }
    environment[name] = assignment.slice(separator + 1);
  }
  return environment;
}

function jsonArgument(argument) {
  try {
    return JSON.parse(argument);
  } catch {
    return argument;
  }
}

async function withExecutionSettings(options, callback) {
  const previousEnvironment = new Map();
  for (const [name, value] of Object.entries(options.env ?? {})) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  const previousCwd = process.cwd();
  if (options.cwd !== undefined) process.chdir(options.cwd);
  try {
    return await callback();
  } finally {
    if (options.cwd !== undefined) process.chdir(previousCwd);
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function runExport(entrypoint, argumentsList, options) {
  const url = pathToFileURL(options.databasePath);
  url.searchParams.set("module", entrypoint.module);
  if (entrypoint.version) url.searchParams.set("version", entrypoint.version);
  url.searchParams.set("cache", `${process.pid}-${Date.now()}`);
  const loaded = await import(url.href);
  const entry = loaded[entrypoint.target];
  if (typeof entry !== "function") {
    throw new Error(
      `entrypoint ${entrypoint.name} target is not a callable export: ${entrypoint.target}`,
    );
  }
  const result = await withExecutionSettings(options, () =>
    entry(...argumentsList.map(jsonArgument)),
  );
  if (result !== undefined) console.log(result);
}

async function runEntrypoint(args, forwardedArguments) {
  const databasePath = resolve(requireArgument(args, 1, "database path"));
  const name = requireArgument(args, 2, "entrypoint name");
  const version = optionValue(args, "version");
  const matches = resolveEntrypoint(databasePath, name, version);
  if (matches.length === 0) {
    throw new Error(
      `entrypoint not found: ${name}${version ? `@${version}` : ""}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `entrypoint is ambiguous: ${name}; use --version to select a version`,
    );
  }

  const entrypoint = matches[0];
  const options = {
    databasePath,
    version: optionValue(args, "version"),
    cwd: optionValue(args, "cwd"),
    env: environmentOptions(args),
  };
  if (entrypoint.kind === "asset") {
    const result = await runBundleEntry({
      ...options,
      moduleKey: entrypoint.module,
      entryPath: entrypoint.target,
      arguments: forwardedArguments,
    });
    if (result.code !== null) process.exitCode = result.code;
    return;
  }
  await runExport(entrypoint, forwardedArguments, options);
}

async function callCommand(args, forwardedArguments) {
  const databasePath = resolve(requireArgument(args, 1, "database path"));
  const moduleKey = requireArgument(args, 2, "module key");
  const target = requireArgument(args, 3, "export");
  await runExport(
    {
      name: `${moduleKey}:${target}`,
      module: moduleKey,
      version: optionValue(args, "version"),
      target,
    },
    forwardedArguments,
    {
      databasePath,
      cwd: optionValue(args, "cwd"),
      env: environmentOptions(args),
    },
  );
}

async function execCommand(args, forwardedArguments) {
  const databasePath = resolve(requireArgument(args, 1, "database path"));
  const moduleKey = requireArgument(args, 2, "module key");
  const entryPath = requireArgument(args, 3, "entrypoint");
  const result = await runBundleEntry({
    databasePath,
    moduleKey,
    entryPath,
    version: optionValue(args, "version"),
    cwd: optionValue(args, "cwd"),
    env: environmentOptions(args),
    arguments: forwardedArguments,
  });
  if (result.code !== null) process.exitCode = result.code;
}

async function inspectCommand(args) {
  const subject = requireArgument(args, 1, "inspect subject");
  const databasePath = resolve(requireArgument(args, 2, "database path"));
  if (subject === "versions") {
    const moduleKey = args[3];
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
  if (subject === "code") {
    const moduleKey = requireArgument(args, 3, "module key");
    process.stdout.write(
      `${compileModuleFile(databasePath, moduleKey, args[4])}\n`,
    );
    return;
  }
  throw new Error(`unknown inspect subject: ${subject}`);
}

async function entrypointsCommand(args) {
  const action = requireArgument(args, 1, "entrypoints action");
  const databasePath = resolve(requireArgument(args, 2, "database path"));
  if (action === "list") {
    const rows = listEntrypoints({
      databasePath,
      moduleKey: args[3]?.startsWith("--") ? undefined : args[3],
      version: optionValue(args, "version"),
    });
    for (const row of rows) {
      console.log(
        `${row.name}\t${row.module}\t${row.version}\t${row.kind}\t${row.target}`,
      );
    }
    return;
  }
  if (action === "set") {
    const result = setEntrypoint({
      databasePath,
      moduleKey: requireArgument(args, 3, "module key"),
      name: requireArgument(args, 4, "entrypoint name"),
      kind: optionValue(args, "kind"),
      target: optionValue(args, "target"),
      version: optionValue(args, "version"),
    });
    console.log(
      `Set ${result.name}: ${result.kind} ${result.module}@${result.version}/${result.target}`,
    );
    return;
  }
  if (action === "remove") {
    const result = removeEntrypoint({
      databasePath,
      moduleKey: requireArgument(args, 3, "module key"),
      name: requireArgument(args, 4, "entrypoint name"),
      version: optionValue(args, "version"),
    });
    console.log(`Removed ${result.name} from ${result.module}@${result.version}`);
    return;
  }
  throw new Error(`unknown entrypoints action: ${action}`);
}

async function importCommand(args) {
  if (args[1] === "--git") {
    const repositoryPath = resolve(requireArgument(args, 2, "repository path"));
    const entryPath = requireArgument(args, 3, "entry path");
    const databasePath = resolve(requireArgument(args, 4, "database path"));
    const moduleKey = args[5]?.startsWith("--") ? undefined : args[5];
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
      `Imported ${graph.versions.length} version(s) across ${graph.manifest.modules.length} module(s) into ${databasePath}`,
    );
    if (graph.packageImports.length > 0) {
      console.log(
        `Runtime package imports left external: ${graph.packageImports.join(", ")}`,
      );
    }
    return;
  }

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
    `Imported ${graph.manifest.modules.length} module(s) into ${databasePath}`,
  );
  if (graph.packageImports.length > 0) {
    console.log(
      `Runtime package imports left external: ${graph.packageImports.join(", ")}`,
    );
  }
}

async function runCommand(rawArgs) {
  const separator = rawArgs.indexOf("--");
  const forwardedArguments =
    separator === -1 ? [] : rawArgs.slice(separator + 1);
  const args = separator === -1 ? rawArgs : rawArgs.slice(0, separator);
  const command = args[0];

  if (command === "build") {
    const manifestPath = resolve(requireArgument(args, 1, "manifest path"));
    const databasePath = resolve(requireArgument(args, 2, "database path"));
    buildDatabase(
      databasePath,
      JSON.parse(readFileSync(manifestPath, "utf8")),
      { overwrite: args.includes("--force") },
    );
    console.log(`Built ${databasePath}`);
    return;
  }
  if (command === "import") {
    await importCommand(args);
    return;
  }
  if (command === "inspect") {
    await inspectCommand(args);
    return;
  }
  if (command === "entrypoints") {
    await entrypointsCommand(args);
    return;
  }
  if (command === "run") {
    await runEntrypoint(args, forwardedArguments);
    return;
  }
  if (command === "call") {
    await callCommand(args, forwardedArguments);
    return;
  }
  if (command === "exec") {
    await execCommand(args, forwardedArguments);
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
