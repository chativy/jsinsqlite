import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const CLI_PATH = new URL("../bin/jsqlite.js", import.meta.url);
const DEMO_MANIFEST = new URL("../examples/demo.manifest.json", import.meta.url);

test("CLI builds a database and prints compiled module source", () => {
  const directory = mkdtempSync(join(tmpdir(), "jsqlite-cli-"));
  const databasePath = join(directory, "demo.sqlite");

  try {
    const build = spawnSync(
      process.execPath,
      [
        CLI_PATH.pathname,
        "build",
        DEMO_MANIFEST.pathname,
        databasePath,
        "--force",
      ],
      { encoding: "utf8" },
    );
    assert.equal(build.status, 0, build.stderr);
    assert.match(build.stdout, /Built .*demo\.sqlite/);

    const compile = spawnSync(
      process.execPath,
      [CLI_PATH.pathname, "compile", databasePath, "main"],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /export class Order/);
    assert.match(compile.stdout, /total\(\) \{/);
    assert.match(compile.stdout, /formatTotal\(order\.total\(\)\)/);

    const run = spawnSync(
      process.execPath,
      [
        CLI_PATH.pathname,
        "call",
        databasePath,
        "lib",
        "formatTotal",
        `--args=${JSON.stringify([42.5])}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "Total: $42.50");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

