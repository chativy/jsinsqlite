#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(skillRoot, "../..");
const cli = join(repositoryRoot, "bin", "jsinsqlite.js");
const manifest = join(skillRoot, "assets", "minimal.manifest.json");
const directory = mkdtempSync(join(tmpdir(), "jsinsqlite-skill-"));
const database = join(directory, "app.sqlite");

function run(argumentsList) {
  return execFileSync(process.execPath, [cli, ...argumentsList], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

try {
  run(["build", manifest, database, "--force"]);

  const modules = run(["inspect", "modules", database]);
  assert.match(modules, /^app\tv0\.1\.0\t1\t/m);

  const entrypoints = run([
    "inspect",
    "entrypoints",
    database,
    "app",
  ]);
  assert.match(entrypoints, /^greet\tapp\tv0\.1\.0\texport\tgreet$/m);

  const output = run(["run", database, "greet", "--", '"world"']);
  assert.equal(output.trim(), "Hello, world");
  console.log("jsinsqlite skill smoke test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
