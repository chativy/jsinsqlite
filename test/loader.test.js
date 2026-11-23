import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildDatabase } from "../src/build.js";
import "../src/register.js";

test("Node imports modules directly from sqlite URLs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jsqlite-loader-"));
  const databasePath = join(directory, "source.sqlite");

  try {
    buildDatabase(databasePath, {
      modules: [
        {
          key: "main",
          entries: [
            {
              key: "main",
              kind: "module",
              source: [
                'import { factorial } from "./source.sqlite?module=lib";',
                "",
                "/* @ref:0 */",
                "",
                "const greeter = new Greeter('Ada');",
                "export const greeting = greeter.greet();",
                "export const answer = factorial(5);",
              ].join("\n"),
              refs: [{ slot: 0, entry: "Greeter" }],
            },
            {
              key: "Greeter",
              kind: "class",
              source: [
                "class Greeter {",
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
          ],
        },
        {
          key: "lib",
          entries: [
            {
              key: "main",
              kind: "module",
              source: [
                "/* @ref:0 */",
                "",
                "export const factorial = calculateFactorial;",
              ].join("\n"),
              refs: [{ slot: 0, entry: "calculateFactorial" }],
            },
            {
              key: "calculateFactorial",
              kind: "function",
              source: [
                "function calculateFactorial(value) {",
                "  return value <= 1 ? 1 : value * calculateFactorial(value - 1);",
                "}",
              ].join("\n"),
            },
          ],
        },
      ],
    });

    const baseUrl = pathToFileURL(databasePath);
    baseUrl.searchParams.set("module", "main");
    baseUrl.searchParams.set("test", `${Date.now()}`);
    const loaded = await import(baseUrl.href);

    assert.equal(loaded.answer, 120);
    assert.equal(loaded.greeting, "Hello, Ada");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

