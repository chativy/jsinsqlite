import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  collectBundlePath,
  importBundleDatabase,
} from "../src/bundle-importer.js";

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function addRequired(files, sourcePath, targetPath) {
  if (!existsSync(sourcePath)) {
    throw new Error(`required coding-agent bundle input is missing: ${sourcePath}`);
  }
  collectBundlePath(files, sourcePath, targetPath);
}

const piRoot = resolve(process.argv[2] ?? "../pi");
const databasePath = resolve(
  process.argv[3] ?? "examples/pi-code.sqlite",
);
const codingAgentRoot = join(piRoot, "packages", "coding-agent");
const bundleRoot = join(codingAgentRoot, "dist", "bundle");
if (!existsSync(join(bundleRoot, "cli-runtime.js"))) {
  throw new Error(
    `coding-agent bundle is missing: ${bundleRoot}; run npm run build in ${piRoot}`,
  );
}

const sourceRevision = git(piRoot, ["rev-parse", "HEAD"]);
const shortRevision = git(piRoot, ["rev-parse", "--short=9", "HEAD"]);
const tag = git(piRoot, ["describe", "--tags", "--abbrev=0", "HEAD"]);
const createdAt = git(piRoot, ["show", "-s", "--format=%cI", "HEAD"]);
const version = `${tag}+${shortRevision}`;
const files = [];

for (const name of ["package.json", "README.md", "CHANGELOG.md"]) {
  addRequired(files, join(codingAgentRoot, name), name);
}
addRequired(files, bundleRoot, "dist/bundle");
addRequired(
  files,
  join(codingAgentRoot, "dist", "modes", "interactive", "theme"),
  "dist/modes/interactive/theme",
);
addRequired(
  files,
  join(codingAgentRoot, "dist", "modes", "interactive", "assets"),
  "dist/modes/interactive/assets",
);
addRequired(
  files,
  join(codingAgentRoot, "dist", "core", "export-html"),
  "dist/core/export-html",
);

for (const packagePath of [
  "jiti",
  "quickjs-wasi",
  "supports-color",
  "@silvia-odwyer/photon-node",
]) {
  addRequired(
    files,
    join(piRoot, "node_modules", packagePath),
    join("node_modules", packagePath),
  );
}

const result = importBundleDatabase({
  databasePath,
  moduleKey: "pi-code",
  description: "Pi coding-agent release bundle",
  sourcePath: bundleRoot,
  entryPath: "dist/bundle/cli.js",
  version,
  tag,
  sourceRevision,
  createdAt,
  files,
  overwrite: true,
});

console.log(
  `Built ${databasePath} with pi-code ${version} (${result.fileCount} files, ${(result.byteCount / 1024 / 1024).toFixed(1)} MiB)`,
);
