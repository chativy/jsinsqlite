---
name: jsinsqlite
description: Explain and guide the design of a single-file SQLite JavaScript application package containing code, node_modules, resources, and a runnable entrypoint. Use when an agent must package or reproduce a JS application as one portable database without relying on an existing jsinsqlite implementation.
---

# jsinsqlite

Use this skill to design a reproducible, implementation-independent way to store
a JavaScript application in one SQLite database and run it later.

Do not assume that the `jsinsqlite` npm package or this repository's CLI exists.
The agent must be able to build the mechanism from the project's available tools
and the database design described here.

## Decide what is being packaged

Package a staged runtime directory, not an arbitrary source checkout.

1. Build or transpile TypeScript and bundler-dependent source first.
2. Resolve whether the app needs the full `node_modules` tree or a bundled
   artifact.
3. Include runtime resources such as templates, images, JSON, WASM, native
   modules, workers, and configuration defaults.
4. Exclude `.git`, caches, temporary files, secrets, and the output database.
5. Choose one relative entrypoint, such as `index.mjs` or `dist/main.js`.

Prefer a bundled executable when bundle correctness can be verified. Store the
full staged directory when the application depends on unbundled `node_modules`,
dynamic imports, workers, or relative resource paths.

Do not treat transpilation or bundling as part of the SQLite concept. Those are
preparation steps; SQLite is the portable storage and extraction layer.

## Design the database

Keep a small archive schema rather than reproducing a complete module loader.

### Archive metadata

Use a key-value table for non-path metadata:

- schema format version
- application name and version
- recorded entrypoint
- package creation time
- deterministic summary digest

### File table

Store one row per packaged path. Each row needs:

- normalized relative path
- file kind: regular file or symbolic link
- content as a BLOB for files, or link target for symlinks
- executable mode bits
- byte size
- per-file checksum

Use the normalized path as the primary key. Add an index on path suffixes or
hashes only when an actual query needs one.

Store all bytes required at runtime. This includes JavaScript, package metadata,
resources, workers, WASM, and native modules. Native binaries remain tied to their
target platform and architecture.

### Determinism

Walk paths in lexical order. Derive the package summary digest from sorted path,
kind, mode, size, and per-file digest values. Use a temporary database for
construction, insert everything in one transaction, then atomically rename the
completed DB.

## Pack safely

Validate before writing:

1. The source directory exists.
2. The entrypoint is a normalized relative path inside the source root.
3. Every stored path stays inside the source root.
4. The output does not already exist unless replacement was explicitly
   requested.
5. The output database is not also being traversed as an input.

Treat symbolic links as links, not recursive directory copies. This avoids loops
and preserves workspace layouts. Document that links pointing outside the staged
root must remain valid on the target system, or the packaging source should be a
larger directory that contains their targets.

Do not follow paths escaping the source root. Do not store credentials from the
environment or user-home configuration unless the user explicitly identifies
them as required runtime resources.

## Inspect before running

An inspection path should report:

- app name and version
- recorded entrypoint
- file and symlink counts
- total unpacked size
- creation time and summary digest

It should also allow listing paths and filtering by prefix or extension. Inspect
the metadata and file table directly when diagnosing a package. Confirm that the
entrypoint exists and that package metadata, dependencies, and expected resources
are present before attempting extraction.

## Run from the database

Running is a controlled extraction followed by a normal Node process.

1. Open the database read-only.
2. Validate the archive format version.
3. Resolve the recorded entrypoint or an explicitly supplied override.
4. Create a fresh temporary directory.
5. Create parent directories and extract regular files and symlinks.
6. Apply mode bits.
7. Verify extraction paths stay inside the temporary root.
8. Run Node on the entrypoint.
9. Use the extracted root as the working directory so relative resources work.
10. Inherit stdio for CLI and TUI behavior.
11. Forward the exit status.
12. Remove the temporary directory after the child exits.

Pass user arguments unchanged. Accept environment variables explicitly rather
than hardcoding application-specific names. Expose the extraction root through a
generic environment variable so applications can locate packaged resources.

## Verification

Build a temporary app that contains:

- one entrypoint
- one local import
- one dependency under `node_modules`
- one nested text resource
- one binary resource

Package it, inspect the metadata and paths, run it from the database, and verify
stdout, exit status, dependency loading, and resource reads.

Also test that extraction fails for paths containing parent-directory traversal
or absolute paths.

## Operational boundaries

- SQLite stores bytes; it does not make native modules portable across platforms.
- Large applications increase extraction cost because execution requires a
  temporary file tree.
- Changing a symlink target may break extraction if the target is outside the
  archive.
- Running a database executes code with the current user's permissions.
- ESM import caches do not apply to child processes, but long-running apps still
  cache modules internally.
- Keep packaging deterministic so identical inputs produce recognizable outputs.
- Never describe the database as a sandbox.
