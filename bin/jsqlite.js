#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDatabase } from "../src/build.js";
import { compileModuleFile } from "../src/compiler.js";
import { importModuleDatabase } from "../src/importer.js";

const USAGE = `Usage:
  jsqlite build <manifest.json> <source.sqlite> [--force]
  jsqlite import <entry.ts> <source.sqlite> [module-key] [--force]
  jsqlite compile <source.sqlite> [module-key] [version]

Module keys default to "main". Use --force to replace an existing database.`;

function requireArgument(args, index, name) {
  const value = args[index];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function run(args) {
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

  throw new Error(USAGE);
}

try {
  run(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

