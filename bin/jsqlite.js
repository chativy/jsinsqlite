#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDatabase } from "../src/build.js";
import { compileModuleFile } from "../src/compiler.js";

const USAGE = `Usage:
  jsqlite build <manifest.json> <source.sqlite> [--force]
  jsqlite compile <source.sqlite> [module-key]

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
    process.stdout.write(`${compileModuleFile(databasePath, moduleKey)}\n`);
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

