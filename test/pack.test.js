import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI_PATH = new URL("../bin/jsinsqlite.js", import.meta.url);

test("pack stores a source directory and runs it from SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "jsinsqlite-pack-"));
  const source = join(directory, "source");
  const dependency = join(source, "node_modules", "message");
  const database = join(directory, "app.sqlite");

  try {
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      join(source, "main.mjs"),
      [
        'import { message } from "message";',
        'import { readFileSync } from "node:fs";',
        'console.log(message, readFileSync(new URL("./resource.txt", import.meta.url), "utf8").trim());',
      ].join("\n"),
    );
    writeFileSync(join(source, "resource.txt"), "resource\n");
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({ name: "message", type: "module", exports: "./index.js" }),
    );
    writeFileSync(
      join(dependency, "index.js"),
      'export const message = "packed";',
    );

    const packed = spawnSync(
      process.execPath,
      [
        CLI_PATH.pathname,
        "pack",
        source,
        database,
        "app",
        "--entry=main.mjs",
      ],
      { encoding: "utf8" },
    );
    assert.equal(packed.status, 0, packed.stderr);

    const run = spawnSync(
      process.execPath,
      [CLI_PATH.pathname, "run", database, "app"],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "packed resource");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
