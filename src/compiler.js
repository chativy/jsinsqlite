import { ROOT_ENTRY_KIND } from "./constants.js";
import { getCachedSourceDatabase } from "./database.js";

const REFERENCE_LINE = /^([ \t]*)\/\*\s*@ref:(\d+)\s*\*\/[ \t\r]*$/;

class SourceEntryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceEntryError";
    this.code = code;
  }
}

function loadModuleGraph(db, moduleKey, requestedVersion) {
  const module = db
    .prepare("SELECT id, key FROM modules WHERE key = ?")
    .get(moduleKey);
  if (!module) {
    throw new SourceEntryError(
      "MODULE_NOT_FOUND",
      `source module not found: ${moduleKey}`,
    );
  }

  const selectedVersion = requestedVersion
    ? db
        .prepare(
          `
            SELECT id, version, tag, source_revision, format, source_path,
                   content_hash, created_at
            FROM module_versions
            WHERE module_id = ? AND version = ?
          `,
        )
        .get(module.id, requestedVersion)
    : db
        .prepare(
          `
            SELECT module_versions.id, module_versions.version,
                   module_versions.tag, module_versions.source_revision,
                   module_versions.format, module_versions.source_path,
                   module_versions.content_hash, module_versions.created_at
            FROM module_heads
            JOIN module_versions
              ON module_versions.id = module_heads.module_version_id
            WHERE module_heads.module_id = ?
          `,
        )
        .get(module.id);
  if (!selectedVersion) {
    throw new SourceEntryError(
      "MODULE_VERSION_NOT_FOUND",
      requestedVersion
        ? `source module version not found: ${moduleKey}@${requestedVersion}`
        : `source module has no versions: ${moduleKey}`,
    );
  }

  const entries = db
    .prepare(
      `
        SELECT id, key, kind, source
        FROM entries
        WHERE module_version_id = ?
        ORDER BY id
      `,
    )
    .all(selectedVersion.id);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

  const roots = entries.filter((entry) => entry.kind === ROOT_ENTRY_KIND);
  if (roots.length !== 1) {
    throw new SourceEntryError(
      "INVALID_ROOT_ENTRY",
      `module ${moduleKey} must have exactly one kind='${ROOT_ENTRY_KIND}' entry`,
    );
  }

  const refsByEntry = new Map();
  const rows = db
    .prepare(
      `
        SELECT refs.from_entry_id, refs.slot, refs.to_entry_id
        FROM entry_refs AS refs
        JOIN entries AS source_entry ON source_entry.id = refs.from_entry_id
        WHERE source_entry.module_version_id = ?
      `,
    )
    .all(selectedVersion.id);

  for (const row of rows) {
    if (!refsByEntry.has(row.from_entry_id)) {
      refsByEntry.set(row.from_entry_id, new Map());
    }
    refsByEntry.get(row.from_entry_id).set(row.slot, row.to_entry_id);
  }

  return {
    module,
    version: selectedVersion,
    entries,
    entriesById,
    refsByEntry,
    root: roots[0],
  };
}

function indentSource(source, indentation) {
  if (indentation === "") return source;
  return source
    .split("\n")
    .map((line) => (line === "" ? line : `${indentation}${line}`))
    .join("\n");
}

function createRenderer(graph, moduleKey) {
  const rendered = new Map();
  const activeEntries = [];

  function renderEntry(entry) {
    if (rendered.has(entry.id)) return rendered.get(entry.id);

    const cycleStart = activeEntries.findIndex(
      (activeEntry) => activeEntry.id === entry.id,
    );
    if (cycleStart !== -1) {
      const cycle = [...activeEntries.slice(cycleStart), entry]
        .map((item) => `${moduleKey}/${item.key}`)
        .join(" -> ");
      throw new SourceEntryError(
        "REFERENCE_CYCLE",
        `entry reference cycle: ${cycle}`,
      );
    }

    const refs = graph.refsByEntry.get(entry.id) ?? new Map();
    const usedSlots = new Set();
    activeEntries.push(entry);

    let source;
    try {
      source = entry.source
        .split("\n")
        .map((line) => {
          const match = REFERENCE_LINE.exec(line);
          if (!match) return line;

          const slot = Number(match[2]);
          if (usedSlots.has(slot)) {
            throw new SourceEntryError(
              "DUPLICATE_SLOT",
              `entry ${moduleKey}/${entry.key} uses ref slot ${slot} more than once`,
            );
          }
          usedSlots.add(slot);

          const targetId = refs.get(slot);
          if (targetId === undefined) {
            throw new SourceEntryError(
              "MISSING_REF",
              `entry ${moduleKey}/${entry.key} has no ref declared for slot ${slot}`,
            );
          }

          const target = graph.entriesById.get(targetId);
          if (!target) {
            throw new SourceEntryError(
              "MISSING_ENTRY",
              `entry ${moduleKey}/${entry.key} ref slot ${slot} points to a missing entry`,
            );
          }

          return indentSource(renderEntry(target), match[1]);
        })
        .join("\n");
    } finally {
      activeEntries.pop();
    }

    for (const slot of refs.keys()) {
      if (!usedSlots.has(slot)) {
        throw new SourceEntryError(
          "UNUSED_REF",
          `entry ${moduleKey}/${entry.key} declares ref slot ${slot} but has no matching placeholder`,
        );
      }
    }

    rendered.set(entry.id, source);
    return source;
  }

  return renderEntry;
}

export function compileModuleRecord(db, moduleKey = "main", version) {
  const graph = loadModuleGraph(db, moduleKey, version);
  const renderEntry = createRenderer(graph, moduleKey);

  // Validate every stored entry, including definitions not reachable from main.
  for (const entry of graph.entries) {
    renderEntry(entry);
  }

  return {
    moduleKey,
    version: graph.version.version,
    tag: graph.version.tag,
    sourceRevision: graph.version.source_revision,
    contentHash: graph.version.content_hash,
    createdAt: graph.version.created_at,
    format: graph.version.format,
    sourcePath: graph.version.source_path,
    source: renderEntry(graph.root),
  };
}

export function compileModule(db, moduleKey = "main", version) {
  return compileModuleRecord(db, moduleKey, version).source;
}

export function compileModuleFileRecord(
  databasePath,
  moduleKey = "main",
  version,
) {
  return compileModuleRecord(
    getCachedSourceDatabase(databasePath),
    moduleKey,
    version,
  );
}

export function compileModuleFile(databasePath, moduleKey = "main", version) {
  return compileModuleFileRecord(databasePath, moduleKey, version).source;
}

export { SourceEntryError };

