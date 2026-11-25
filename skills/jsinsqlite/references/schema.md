# jsinsqlite schema

## Relationships

```text
modules
  1 ── n module_versions
                 │
                 ├─ 1 module_heads
                 ├─ n entries ── n entry_refs
                 ├─ n module_assets
                 └─ n version_entrypoints
```

## Tables

### `modules`

Logical module identity.

| Column | Meaning |
| --- | --- |
| `id` | Integer primary key |
| `key` | Stable module name, unique |
| `description` | Optional description |

### `module_versions`

Immutable version metadata.

| Column | Meaning |
| --- | --- |
| `id` | Integer primary key |
| `module_id` | Owning module |
| `version` | Version notation, unique per module |
| `tag` | Optional source tag |
| `source_revision` | Optional full revision |
| `format` | `js` or `ts` |
| `source_path` | Default/source entry metadata |
| `content_hash` | Version content hash |
| `created_at` | Selection and display timestamp |

### `module_heads`

One row per module. Selects the default version for `run` and URL imports.

```sql
SELECT modules.key, module_versions.version
FROM modules
JOIN module_heads ON module_heads.module_id = modules.id
JOIN module_versions
  ON module_versions.id = module_heads.module_version_id;
```

### `version_entrypoints`

Named executable targets scoped to one version.

| Column | Meaning |
| --- | --- |
| `module_version_id` | Owning version |
| `name` | User-facing entrypoint name |
| `kind` | `asset` or `export` |
| `target` | Asset path or export name |

### `entries`

Composed source fragments. Each version has exactly one root row with
`kind='module'` and `key='main'`.

### `entry_refs`

Ordered references from a source fragment slot to another entry. The source
contains a line such as `/* @ref:0 */`; slot `0` resolves to the referenced
entry.

### `module_assets`

Runtime files as BLOBs, unique by `(module_version_id, path)`.

```sql
SELECT path, length(content) AS bytes, mode
FROM module_assets
WHERE module_version_id = ?;
```

### `jsinsqlite_meta`

Contains `schema_version`. Current supported version is `7`.

## Useful queries

List modules and heads:

```sql
SELECT modules.key, module_versions.version AS head
FROM modules
JOIN module_heads ON module_heads.module_id = modules.id
JOIN module_versions
  ON module_versions.id = module_heads.module_version_id
ORDER BY modules.key;
```

List entrypoints for the current heads:

```sql
SELECT modules.key, module_versions.version,
       version_entrypoints.name, version_entrypoints.kind,
       version_entrypoints.target
FROM version_entrypoints
JOIN module_versions
  ON module_versions.id = version_entrypoints.module_version_id
JOIN modules ON modules.id = module_versions.module_id
JOIN module_heads
  ON module_heads.module_version_id = module_versions.id
ORDER BY modules.key, version_entrypoints.name;
```

Inspect an asset:

```sql
SELECT path, length(content), mode
FROM module_assets
WHERE module_version_id = ?
  AND path = ?;
```

## Clone a version checklist

Use one transaction:

1. Insert the new `module_versions` row.
2. Copy `entries` and remap old-to-new entry IDs.
3. Copy `entry_refs` using the remapped IDs.
4. Copy `module_assets`, replacing only explicitly changed BLOBs.
5. Copy `version_entrypoints`, replacing changed targets.
6. Update the new version's `content_hash`.
7. Update `module_heads` to the new version.
8. Commit.

Do not delete the previous head until the new version has all required entries,
assets, and entrypoints.
