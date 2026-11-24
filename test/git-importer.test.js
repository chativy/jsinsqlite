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
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  collectGitVersions,
  importGitVersions,
} from "../src/git-importer.js";
import "../src/register.js";

function git(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "jsinsqlite-git-"));
  const sourceDirectory = join(repository, "src");
  mkdirSync(sourceDirectory);
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);

  for (let value = 1; value <= 5; value += 1) {
    writeFileSync(
      join(sourceDirectory, "main.ts"),
      [
        'import { offset } from "./dep.ts";',
        `export const value: number = ${value} + offset;`,
      ].join("\n"),
    );
    writeFileSync(
      join(sourceDirectory, "dep.ts"),
      "export const offset: number = 1;",
    );
    git(repository, ["add", "src/main.ts", "src/dep.ts"]);
    git(repository, ["commit", "-m", `version ${value}`]);
    if (value === 1) git(repository, ["tag", "v1.0.0"]);
  }

  return {
    repository,
    databasePath: join(repository, "source.sqlite"),
  };
}

test("collectGitVersions uses the latest tag plus revision notation", () => {
  const fixture = createRepository();

  try {
    const graph = collectGitVersions({
      repositoryPath: fixture.repository,
      entryPath: "src/main.ts",
      historyPath: "src",
      moduleKey: "main",
      limit: 5,
    });

    assert.equal(graph.versions.length, 5);
    assert.equal(graph.versions.at(-1).version, "v1.0.0");
    for (const version of graph.versions.slice(0, -1)) {
      assert.match(version.version, /^v1\.0\.0\+[0-9a-f]+$/);
    }
    const mainModule = graph.manifest.modules.find(
      (module) => module.key === "main",
    );
    assert.equal(mainModule.versions.length, 5);
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test("importGitVersions stores and imports old and latest snapshots", async () => {
  const fixture = createRepository();

  try {
    const graph = importGitVersions({
      repositoryPath: fixture.repository,
      entryPath: "src/main.ts",
      historyPath: "src",
      databasePath: fixture.databasePath,
      moduleKey: "main",
      limit: 5,
    });

    const latestUrl = pathToFileURL(fixture.databasePath);
    latestUrl.searchParams.set("module", "main");
    latestUrl.searchParams.set("test", `${Date.now()}-latest`);
    assert.equal((await import(latestUrl.href)).value, 6);

    const oldestVersion = graph.versions.at(-1).version;
    const oldUrl = pathToFileURL(fixture.databasePath);
    oldUrl.searchParams.set("module", "main");
    oldUrl.searchParams.set("version", oldestVersion);
    oldUrl.searchParams.set("test", `${Date.now()}-old`);
    assert.equal((await import(oldUrl.href)).value, 2);
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});
