---
name: jsinsqlite
description: Store, version, inspect, and run JavaScript or TypeScript applications and runtime assets in SQLite with jsinsqlite. Use when packaging Node.js code and dependencies into a database, managing DB-backed entrypoints, or diagnosing an existing jsinsqlite database.
---

# jsinsqlite

Use `jsinsqlite` to treat a SQLite database as the source and runtime artifact:
versioned source entries, JavaScript/TypeScript assets, dependency bundles, and
named entrypoints all live in one DB file.

## Choose the CLI

Inside this repository, prefer:

```bash
node bin/jsinsqlite.js <command>
```

For an installed package, use `jsinsqlite` or `npx jsinsqlite`. Do not add
application-specific names or environment variables to CLI code. Pass them as
DB metadata and generic `--env=NAME=VALUE` arguments.

## Start from the DB

Never assume a module key, version, or entrypoint. Inspect first:

```bash
jsinsqlite inspect modules app.sqlite
jsinsqlite inspect versions app.sqlite
jsinsqlite inspect entrypoints app.sqlite
```

Select a specific version with `--version=<version>` when the head is not the
intended target. `inspect entrypoints` lists every version unless filtered.

For schema relationships and direct SQL diagnostics, read
[references/schema.md](references/schema.md).

## Create source versions

### Import TypeScript or JavaScript

Import one entry and its local runtime dependency graph:

```bash
jsinsqlite import src/main.ts app.sqlite app
```

Import recent Git snapshots:

```bash
jsinsqlite import --git . src/main.ts app.sqlite app \
  --limit=5 --history=src
```

The importer resolves local imports recursively, ignores `import type`,
rewrites local imports to `jsinsqlite:<module>`, and splits top-level
declarations into entries. Runtime npm imports are reported but not mapped into
SQLite automatically.

### Build a manifest

Use `build` for explicit entries, versions, assets, and entrypoints:

```bash
jsinsqlite build app.manifest.json app.sqlite --force
```

[assets/minimal.manifest.json](assets/minimal.manifest.json) is a runnable
template. A version must contain exactly one root entry with
`kind: "module"` and `key: "main"`.

To compose source fragments, place a marker on its own line:

```js
/* @ref:0 */
```

The marker's indentation is applied to every inserted line. References must be
acyclic and every declared slot must appear exactly once.

## Configure entrypoints

Entrypoints are version-scoped through `version_entrypoints`.

```bash
jsinsqlite entrypoints add app.sqlite app app \
  --kind=asset --target=dist/entry.js

jsinsqlite entrypoints add app.sqlite app greet \
  --kind=export --target=greet
```

Use `--version=<version>` to target a non-head version. For asset entrypoints,
the target must already exist in `module_assets` for that version.

Remove:

```bash
jsinsqlite entrypoints remove app.sqlite app greet
```

Bundle imports automatically create an asset entrypoint named after the module.

## Run

Prefer the named entrypoint:

```bash
jsinsqlite run app.sqlite app \
  --env=API_KEY=secret -- \
  --entrypoint-flag value
```

Execution semantics:

- `kind=asset`: extract the selected version's asset tree to a temporary
  directory and spawn Node on the target.
- `kind=export`: import the selected DB module and call the target export.
- `--` arguments pass to assets unchanged. Export arguments are JSON-decoded
  individually, with non-JSON values remaining strings.
- `JSINSQLITE_BUNDLE_ROOT` points at the extracted asset root.

Bypass entrypoint lookup only for debugging or dynamic targets:

```bash
jsinsqlite call app.sqlite app greet -- '"world"'
jsinsqlite exec app.sqlite app dist/entry.js -- --version
```

## Direct ESM imports

Register the loader before any static SQLite import:

```bash
node --import jsinsqlite/register app.mjs
```

```js
import { summary } from "./app.sqlite?module=app";
import { helper } from "jsinsqlite:lib";
```

The `module` query selects the module; omitting it selects `main`. Add
`version=<version>` to select a version. Internal `jsinsqlite:<module>` imports
inherit the parent DB and version.

## Modify databases safely

- Work inside a transaction for multi-table changes.
- Preserve immutability: create a new `module_versions` row instead of editing
  an old version's semantics in place.
- When cloning a version, copy entries, entry references, assets, and
  entrypoints, then update `module_heads` explicitly.
- Keep `content_hash` consistent with the selected version.
- For asset changes, update or clone the BLOB before updating the version and
  head.

The exact columns and clone checklist are in
[references/schema.md](references/schema.md).

## Verify

Run the repository smoke test:

```bash
node skills/jsinsqlite/scripts/smoke.mjs
```

It builds the bundled minimal manifest in a temporary directory, inspects the
module and entrypoint, executes the export, and checks `Hello, world`.
