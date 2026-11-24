import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const CLI_PATH = new URL("../bin/jsinsqlite.js", import.meta.url);
const DEMO_MANIFEST = new URL("../examples/demo.manifest.json", import.meta.url);

test("CLI builds, inspects, configures, and runs an entrypoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "jsinsqlite-cli-"));
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
      [CLI_PATH.pathname, "inspect", "code", databasePath, "main"],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /export class Order/);
    assert.match(compile.stdout, /total\(\) \{/);
    assert.match(compile.stdout, /formatTotal\(order\.total\(\)\)/);

    const set = spawnSync(
      process.execPath,
      [
        CLI_PATH.pathname,
        "entrypoints",
        "set",
        databasePath,
        "lib",
        "formatTotal",
        "--kind=export",
        "--target=formatTotal",
      ],
      { encoding: "utf8" },
    );
    assert.equal(set.status, 0, set.stderr);

    const list = spawnSync(
      process.execPath,
      [CLI_PATH.pathname, "entrypoints", "list", databasePath, "lib"],
      { encoding: "utf8" },
    );
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /formatTotal\tlib\tlocal\texport\tformatTotal/);

    const run = spawnSync(
      process.execPath,
      [CLI_PATH.pathname, "run", databasePath, "formatTotal", "--", "42.5"],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "Total: $42.50");

    const call = spawnSync(
      process.execPath,
      [
        CLI_PATH.pathname,
        "call",
        databasePath,
        "lib",
        "formatTotal",
        "--",
        "10",
      ],
      { encoding: "utf8" },
    );
    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout.trim(), "Total: $10.00");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

