import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  collectModuleGraph,
  importModuleDatabase,
} from "../src/importer.js";
import { compileModuleFile } from "../src/compiler.js";
import "../src/register.js";

function createSources() {
  const directory = mkdtempSync(join(tmpdir(), "jsqlite-import-"));
  const entryPath = join(directory, "main.ts");
  const dependencyPath = join(directory, "dep.ts");

  writeFileSync(
    entryPath,
    [
      'import { helper } from "./dep.ts";',
      "",
      "export type Choice = { readonly name?: string };",
      "",
      "export const DEFAULT_PORT = 8789;",
      "",
      "export function valueOf(choice: Choice): number {",
      '  return helper(choice.name ?? "pi");',
      "}",
    ].join("\n"),
  );
  writeFileSync(
    dependencyPath,
    [
      'import type { PathLike } from "node:fs";',
      "",
      "export function helper(name: string): number {",
      "  return name.length;",
      "}",
    ].join("\n"),
  );

  return { directory, entryPath, databasePath: join(directory, "source.sqlite") };
}

test("collectModuleGraph recursively imports local TypeScript dependencies", () => {
  const sources = createSources();

  try {
    const graph = collectModuleGraph(sources.entryPath, {
      moduleKey: "pi",
    });

    assert.deepEqual(
      graph.manifest.modules.map((module) => module.key),
      ["dep", "pi"],
    );
    assert.deepEqual(graph.packageImports, []);
    assert.deepEqual(
      graph.manifest.modules[1].entries.map((entry) => entry.key),
      ["main", "Choice", "DEFAULT_PORT", "valueOf"],
    );
    assert.equal(graph.manifest.modules[1].sourcePath, "main.ts");
    assert.match(
      graph.manifest.modules[1].entries[0].source,
      /from "jsqlite:dep"/,
    );
  } finally {
    rmSync(sources.directory, { recursive: true, force: true });
  }
});

test("imported TypeScript graph runs from one sqlite database", async () => {
  const sources = createSources();

  try {
    importModuleDatabase({
      entryPath: sources.entryPath,
      databasePath: sources.databasePath,
      moduleKey: "pi",
    });

    const compiled = compileModuleFile(sources.databasePath, "pi");
    assert.equal(compiled.match(/export const DEFAULT_PORT/g)?.length, 1);

    const url = pathToFileURL(sources.databasePath);
    url.searchParams.set("module", "pi");
    url.searchParams.set("test", `${Date.now()}-import`);
    const loaded = await import(url.href);

    assert.equal(loaded.DEFAULT_PORT, 8789);
    assert.equal(loaded.valueOf({}), 2);
    assert.equal(loaded.valueOf({ name: "work" }), 4);
  } finally {
    rmSync(sources.directory, { recursive: true, force: true });
  }
});
