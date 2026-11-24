# jsinsqlite

`jsinsqlite` stores versioned JavaScript and TypeScript source entries, runtime
assets, and named entrypoints in SQLite. Node can import composed source modules
directly from a database URL, or execute a complete asset bundle from a selected
SQLite version.

## Installation

Node.js 22.18 or newer is required.

Install the CLI globally:

```bash
npm install --global jsinsqlite
jsinsqlite inspect modules app.sqlite
```

Install it as a project dependency:

```bash
npm install jsinsqlite
npx jsinsqlite inspect modules app.sqlite
```

Register the SQLite ESM loader in a Node.js application:

```bash
node --import jsinsqlite/register app.mjs
```

Import the programmatic API:

```js
import {
  buildDatabase,
  compileModuleFile,
  importModuleDatabase,
  validateManifest,
} from "jsinsqlite";
```

From a source checkout, run the test suite and demo:

```bash
npm test
npm run demo
```

Demo output:

```text
Total: $42.00
```

## Concepts

| Concept | Meaning |
| --- | --- |
| Module | A logical source module such as `app` or `lib` |
| Version | An immutable source snapshot with an optional tag and revision |
| Head | The default version used when `--version` is omitted |
| Entry | A stored source fragment such as `main`, a function, or a class |
| Asset | A text or binary runtime file stored as a BLOB |
| Entrypoint | A named executable target for a module version |

There are two entrypoint kinds:

- `asset`: extract a version's asset tree and execute one file in a child process
- `export`: import a composed DB module and call one exported function

The `run` command hides those differences. `call` and `exec` expose them
directly for advanced use.

## Commands

```text
build        Create a database from a JSON manifest
import       Create a database from source or Git history
inspect      Show modules, versions, entrypoints, or composed source
entrypoints  Add or remove named entrypoints
run          Run a named entrypoint
call         Advanced: call an exported function without an entrypoint row
exec         Advanced: execute an asset file without an entrypoint row
```

### `build`

Build from an explicit manifest:

```bash
node bin/jsinsqlite.js build app.manifest.json app.sqlite
node bin/jsinsqlite.js build app.manifest.json app.sqlite --force
```

Minimal manifest for a source module:

```json
{
  "modules": [
    {
      "key": "app",
      "versions": [
        {
          "version": "v1.0.0",
          "tag": "v1.0.0",
          "format": "js",
          "entries": [
            {
              "key": "main",
              "kind": "module",
              "source": "/* @ref:0 */\nexport const answer = value;",
              "refs": [{ "slot": 0, "entry": "value" }]
            },
            {
              "key": "value",
              "kind": "constant",
              "source": "const value = 42;"
            }
          ]
        }
      ]
    }
  ]
}
```

Every version must contain exactly one root entry with `kind: "module"` and
`key: "main"`.

### `import`

Import one TypeScript or JavaScript entry and its local runtime dependency
graph:

```bash
node bin/jsinsqlite.js import src/main.ts app.sqlite app
```

Import recent Git snapshots:

```bash
node bin/jsinsqlite.js import --git . src/main.ts app.sqlite app \
  --limit=5 --history=src
```

The importer:

- resolves local imports recursively
- excludes `import type`
- rewrites local imports to `jsinsqlite:<module>`
- splits top-level declarations into separate entries
- records tag and revision metadata

Runtime npm imports are reported but are not expanded automatically. Bundle
them before storing an executable asset graph.

## Entrypoints

Entrypoints are stored per module version in `version_entrypoints`.

```sql
CREATE TABLE version_entrypoints (
  module_version_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('asset', 'export')),
  target TEXT NOT NULL,
  PRIMARY KEY (module_version_id, name)
);
```

List entrypoints:

```bash
node bin/jsinsqlite.js inspect entrypoints app.sqlite
node bin/jsinsqlite.js inspect entrypoints app.sqlite app
node bin/jsinsqlite.js inspect entrypoints app.sqlite app --version=v1.0.0
```

Output columns:

```text
name  module  version  kind  target
```

Create an asset entrypoint on the module head:

```bash
node bin/jsinsqlite.js entrypoints add app.sqlite app app \
  --kind=asset --target=dist/entry.js
```

Create an export entrypoint:

```bash
node bin/jsinsqlite.js entrypoints add app.sqlite app hello \
  --kind=export --target=hello
```

Set an entrypoint on a specific version:

```bash
node bin/jsinsqlite.js entrypoints add app.sqlite app app \
  --kind=asset --target=dist/entry.js --version=v1.0.0
```

Remove an entrypoint:

```bash
node bin/jsinsqlite.js entrypoints remove app.sqlite app app
```

Bundle import creates an asset entrypoint automatically, using the module key as
its name.

## Running entrypoints

Run a named entrypoint from the selected module head:

```bash
node bin/jsinsqlite.js run app.sqlite app \
  --env=API_TOKEN=secret -- \
  --flag "entrypoint argument"
```

Select a version:

```bash
node bin/jsinsqlite.js run app.sqlite app \
  --version=v1.0.0 \
  --env=MODE=test
```

Set the working directory:

```bash
node bin/jsinsqlite.js run app.sqlite app --cwd=/path/to/project
```

Rules:

- `--env=NAME=VALUE` may be repeated.
- `--cwd=path` selects the child process working directory for assets.
- Arguments after `--` are passed to the entrypoint unchanged.
- Asset entrypoints inherit TTY and signal handling through a child process.
- Export arguments are JSON-decoded individually; invalid JSON is passed as a
  string.
- `JSINSQLITE_BUNDLE_ROOT` is set to the extracted asset root.

If the same entrypoint name exists in multiple module heads, `run` rejects the
name as ambiguous. Use a unique name or provide `--version`.

### Advanced direct execution

Call an exported function without an entrypoint row:

```bash
node bin/jsinsqlite.js call app.sqlite app hello -- 'world'
```

Execute an asset path without an entrypoint row:

```bash
node bin/jsinsqlite.js exec app.sqlite app dist/entry.js \
  --env=API_TOKEN=secret -- \
  --flag value
```

`call` and `exec` support the same `--version`, `--cwd`, `--env`, and `--`
conventions as `run`.

## Inspection

List module keys with their current head, version count, and description:

```bash
node bin/jsinsqlite.js inspect modules app.sqlite
```

```text
app     v1.0.0  3  Application module
lib     v1.0.0  1  Shared library
```

List versions:

```bash
node bin/jsinsqlite.js inspect versions app.sqlite
node bin/jsinsqlite.js inspect versions app.sqlite app
```

Print composed source:

```bash
node bin/jsinsqlite.js inspect code app.sqlite app
node bin/jsinsqlite.js inspect code app.sqlite app v1.0.0
```

## SQLite module imports

Register the ESM loader before the application imports SQLite modules:

```bash
node --import ./src/register.js app.mjs
```

Installed package:

```bash
node --import jsinsqlite/register app.mjs
```

Import the current head of a module:

```js
import { summary } from "./app.sqlite?module=app";
```

Select a version:

```js
import { summary } from "./app.sqlite?module=app&version=v1.0.0";
```

Inside SQLite-backed source, import another module from the same DB:

```js
import { formatTotal } from "jsinsqlite:lib";
```

The loader resolves `jsinsqlite:lib` against the parent SQLite file and preserves
the selected version query.

## Source entry composition

Place a slot marker on its own line:

```js
/* @ref:0 */
```

The slot's indentation is applied to every inserted source line. This allows a
method entry to be stored separately while preserving class indentation.

Example root entry:

```js
import { formatTotal } from "jsinsqlite:lib";

/* @ref:0 */

const order = new Order([12, 30]);
export const summary = formatTotal(order.total());
```

Class entry:

```js
export class Order {
  #items;

  constructor(items) {
    this.#items = items;
  }

  /* @ref:0 */
}
```

Method entry:

```js
total() {
  return this.#items.reduce((sum, value) => sum + value, 0);
}
```

The compiler rejects missing references, unused references, duplicate slots,
missing entries, and cycles.

## Schema

Core tables:

| Table | Purpose |
| --- | --- |
| `modules` | Logical module identities |
| `module_versions` | Immutable version metadata |
| `module_heads` | Default version per module |
| `version_entrypoints` | Named asset/export targets per version |
| `entries` | Source fragments |
| `entry_refs` | Ordered slot references between source fragments |
| `module_assets` | Runtime files stored as BLOBs |
| `jsinsqlite_meta` | Schema metadata |

## API

```js
import {
  buildDatabase,
  compileModuleFile,
  importGitVersions,
  importModuleDatabase,
  listEntrypoints,
  runBundleEntry,
  setEntrypoint,
  validateManifest,
} from "jsinsqlite";
```

The CLI is the primary interface. The API exposes the same manifest, import,
compiler, asset, and entrypoint primitives for programmatic use.

## Security and caching

Code loaded from SQLite executes with the current Node process permissions. Do
not import or execute untrusted databases without an external sandbox.

Node caches ESM modules by URL. After changing a module version currently
imported by a running process, restart the process or use a new URL cache key.
The `run` and `exec` commands use a fresh child process for asset entrypoints.

## Example: pi-code bundle

`examples/pi-code.sqlite` contains a bundled coding agent and its runtime assets.
Its registered entrypoint is:

```text
name:   pi-code
kind:   asset
target: dist/bundle/cli.js
```

List it:

```bash
node bin/jsinsqlite.js inspect entrypoints examples/pi-code.sqlite pi-code
```

Run it with an environment variable:

```bash
node bin/jsinsqlite.js run examples/pi-code.sqlite pi-code \
  --env=API_KEY=secret -- \
  -p "Reply with exactly: ok"
```

The generic CLI does not know about `pi-code` or any application-specific
environment variable. All application behavior is selected through the database,
its entrypoints, and supplied arguments.
