import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { importBundleDatabase } from "../src/bundle-importer.js";

const CLI_PATH = new URL("../bin/jsqlite.js", import.meta.url);

test("bundle files are stored in sqlite and run from the extracted tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "jsqlite-bundle-test-"));
  const databasePath = join(directory, "bundle.sqlite");

  try {
    importBundleDatabase({
      databasePath,
      moduleKey: "app",
      entryPath: "dist/bundle/cli.js",
      version: "v1.0.0",
      files: [
        {
          path: "dist/bundle/cli.js",
          content: Buffer.from(
            'console.log("bundle", process.argv.slice(2).join(" "));',
          ),
          mode: 0o755,
        },
        {
          path: "package.json",
          content: Buffer.from('{"name":"app"}'),
          mode: 0o644,
        },
      ],
    });

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM module_assets").get().count,
        2,
      );
    } finally {
      db.close();
    }

    const result = spawnSync(
      process.execPath,
      [
        CLI_PATH.pathname,
        "exec",
        databasePath,
        "app",
        "dist/bundle/cli.js",
        "--",
        "--help",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "bundle --help");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exec passes generic environment variables to the selected entrypoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "jsqlite-exec-"));
  const databasePath = join(directory, "bundle.sqlite");

  try {
    importBundleDatabase({
      databasePath,
      moduleKey: "app",
      entryPath: "dist/env.js",
      version: "v1.0.0",
      files: [
        {
          path: "dist/env.js",
          content: Buffer.from(
            'console.log(process.env.TEST_SECRET ?? "missing");',
          ),
          mode: 0o755,
        },
      ],
    });

    const result = spawnSync(
      process.execPath,
      [
        CLI_PATH.pathname,
        "exec",
        databasePath,
        "app",
        "dist/env.js",
        "--env=TEST_SECRET=test-secret",
        "--",
        "--version",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "test-secret");
    assert.doesNotMatch(result.stdout, /--env/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
