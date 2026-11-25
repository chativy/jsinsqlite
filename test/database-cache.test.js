import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDatabase } from "../src/build.js";
import {
  closeCachedSourceDatabases,
  getCachedSourceDatabase,
  invalidateSourceDatabase,
} from "../src/database.js";

function manifest(value) {
  return {
    modules: [
      {
        key: "app",
        versions: [
          {
            version: "v1",
            entries: [
              {
                key: "main",
                kind: "module",
                source: `export const value = ${value};`,
              },
            ],
          },
        ],
      },
    ],
  };
}

test("read-only connections are reused until explicitly invalidated", () => {
  const directory = mkdtempSync(join(tmpdir(), "jsinsqlite-cache-"));
  const databasePath = join(directory, "app.sqlite");
  try {
    buildDatabase(databasePath, manifest(1));
    const first = getCachedSourceDatabase(databasePath);
    const second = getCachedSourceDatabase(databasePath);
    assert.equal(second, first);

    assert.equal(invalidateSourceDatabase(databasePath), true);
    const third = getCachedSourceDatabase(databasePath);
    assert.notEqual(third, first);
    assert.equal(
      third.prepare("SELECT count(*) AS count FROM modules").get().count,
      1,
    );
  } finally {
    closeCachedSourceDatabases();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rebuilding a database invalidates its cached read connection", () => {
  const directory = mkdtempSync(join(tmpdir(), "jsinsqlite-cache-"));
  const databasePath = join(directory, "app.sqlite");
  try {
    buildDatabase(databasePath, manifest(1));
    const first = getCachedSourceDatabase(databasePath);

    buildDatabase(databasePath, manifest(2), { overwrite: true });
    const second = getCachedSourceDatabase(databasePath);
    assert.notEqual(second, first);
    assert.equal(
      second
        .prepare(
          `
            SELECT source FROM entries
            WHERE module_version_id = (
              SELECT id FROM module_versions
              WHERE module_id = (SELECT id FROM modules WHERE key = 'app')
            )
            AND key = 'main'
          `,
        )
        .get().source,
      "export const value = 2;",
    );
  } finally {
    closeCachedSourceDatabases();
    rmSync(directory, { recursive: true, force: true });
  }
});
