import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildDatabase, validateManifest } from "../src/build.js";

function createManifest() {
  return {
    modules: [
      {
        key: "main",
        description: "test module",
        format: "ts",
        sourcePath: "src/main.ts",
        entries: [
          {
            key: "main",
            kind: "module",
            source: "export const answer = 42;",
          },
          {
            key: "answer",
            kind: "constant",
            source: "42",
          },
        ],
      },
    ],
  };
}

test("buildDatabase writes modules, entries, and references", () => {
  const directory = mkdtempSync(join(tmpdir(), "jsqlite-build-"));
  const databasePath = join(directory, "source.sqlite");

  try {
    const manifest = createManifest();
    manifest.modules[0].entries[0].source =
      "/* @ref:0 */\nexport const answer = 42;";
    manifest.modules[0].entries[0].refs = [
      { slot: 0, entry: "answer" },
    ];

    buildDatabase(databasePath, manifest);

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT value FROM jsqlite_meta").get().value,
        "2",
      );
      assert.equal(
        db
          .prepare(
            "SELECT description, format, source_path FROM modules WHERE key = 'main'",
          )
          .get().format,
        "ts",
      );
      assert.equal(
        db.prepare("SELECT source_path FROM modules WHERE key = 'main'").get()
          .source_path,
        "src/main.ts",
      );
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM entries").get().count,
        2,
      );
      assert.equal(
        db.prepare("SELECT slot FROM entry_refs").get().slot,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validateManifest rejects references outside the same module", () => {
  assert.throws(
    () =>
      validateManifest({
        modules: [
          {
            key: "main",
            entries: [
              {
                key: "main",
                kind: "module",
                source: "/* @ref:0 */",
                refs: [{ slot: 0, entry: "missing" }],
              },
            ],
          },
        ],
      }),
    /references missing entry main\/missing/,
  );
});

test("buildDatabase refuses to replace an existing database by default", () => {
  const directory = mkdtempSync(join(tmpdir(), "jsqlite-build-"));
  const databasePath = join(directory, "source.sqlite");

  try {
    buildDatabase(databasePath, createManifest());
    assert.throws(
      () => buildDatabase(databasePath, createManifest()),
      /database already exists/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
