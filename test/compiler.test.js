import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDatabase } from "../src/build.js";
import { compileModuleFile } from "../src/compiler.js";

function withDatabase(manifest, callback) {
  const directory = mkdtempSync(join(tmpdir(), "jsqlite-compile-"));
  const databasePath = join(directory, "source.sqlite");
  try {
    buildDatabase(databasePath, manifest);
    return callback(databasePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createClassManifest() {
  return {
    modules: [
      {
        key: "main",
        entries: [
          {
            key: "main",
            kind: "module",
            source: [
              "/* @ref:0 */",
              "/* @ref:1 */",
              "",
              "const greeter = new Greeter('Ada');",
              "export const message = greeter.greet();",
              "export const doubled = double(21);",
            ].join("\n"),
            refs: [
              { slot: 0, entry: "Greeter" },
              { slot: 1, entry: "double" },
            ],
          },
          {
            key: "Greeter",
            kind: "class",
            source: [
              "export class Greeter {",
              "  constructor(name) {",
              "    this.name = name;",
              "  }",
              "",
              "  /* @ref:0 */",
              "}",
            ].join("\n"),
            refs: [{ slot: 0, entry: "Greeter.greet" }],
          },
          {
            key: "Greeter.greet",
            kind: "method",
            source: [
              "greet() {",
              "  return `Hello, ${this.name}`;",
              "}",
            ].join("\n"),
          },
          {
            key: "double",
            kind: "function",
            source: [
              "export function double(value) {",
              "  return value * 2;",
              "}",
            ].join("\n"),
          },
        ],
      },
    ],
  };
}

test("compileModuleFile inserts class methods with matching indentation", () => {
  withDatabase(createClassManifest(), (databasePath) => {
    assert.equal(
      compileModuleFile(databasePath),
      [
        "export class Greeter {",
        "  constructor(name) {",
        "    this.name = name;",
        "  }",
        "",
        "  greet() {",
        "    return `Hello, ${this.name}`;",
        "  }",
        "}",
        "export function double(value) {",
        "  return value * 2;",
        "}",
        "",
        "const greeter = new Greeter('Ada');",
        "export const message = greeter.greet();",
        "export const doubled = double(21);",
      ].join("\n"),
    );
  });
});

test("compileModuleFile reports a placeholder without a declared ref", () => {
  const manifest = {
    modules: [
      {
        key: "main",
        entries: [
          {
            key: "main",
            kind: "module",
            source: "/* @ref:0 */",
          },
        ],
      },
    ],
  };

  withDatabase(manifest, (databasePath) => {
    assert.throws(
      () => compileModuleFile(databasePath),
      /has no ref declared for slot 0/,
    );
  });
});

test("compileModuleFile reports declared refs without placeholders", () => {
  const manifest = {
    modules: [
      {
        key: "main",
        entries: [
          {
            key: "main",
            kind: "module",
            source: "export const value = 1;",
            refs: [{ slot: 0, entry: "unused" }],
          },
          {
            key: "unused",
            kind: "snippet",
            source: "export const unused = true;",
          },
        ],
      },
    ],
  };

  withDatabase(manifest, (databasePath) => {
    assert.throws(
      () => compileModuleFile(databasePath),
      /declares ref slot 0 but has no matching placeholder/,
    );
  });
});

test("compileModuleFile reports reference cycles with their entry path", () => {
  const manifest = {
    modules: [
      {
        key: "main",
        entries: [
          {
            key: "main",
            kind: "module",
            source: "/* @ref:0 */",
            refs: [{ slot: 0, entry: "a" }],
          },
          {
            key: "a",
            kind: "snippet",
            source: "/* @ref:0 */",
            refs: [{ slot: 0, entry: "main" }],
          },
        ],
      },
    ],
  };

  withDatabase(manifest, (databasePath) => {
    assert.throws(
      () => compileModuleFile(databasePath),
      /main\/main -> main\/a -> main\/main/,
    );
  });
});
