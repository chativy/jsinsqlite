import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";
import { buildDatabase } from "./build.js";

const BUILTINS = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);

function isRelativeSpecifier(specifier) {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

function isNodeBuiltin(specifier) {
  return (
    specifier.startsWith("node:") ||
    BUILTINS.has(specifier.split("/")[0])
  );
}

function sourceFormat(path) {
  const extension = extname(path);
  if ([".ts", ".mts", ".cts"].includes(extension)) return "ts";
  if ([".js", ".mjs"].includes(extension)) return "js";
  throw new Error(
    `unsupported source extension ${extension || "(none)"}: ${path}`,
  );
}

function moduleKeyFor(path, rootDirectory) {
  const key = relative(rootDirectory, path)
    .split(sep)
    .join("/")
    .replace(/\.[^.]+$/, "")
    .replace(/\/index$/, "");
  return key || basename(path, extname(path));
}

function resolveLocalImport(specifier, importerPath) {
  const base = resolve(dirname(importerPath), specifier);
  const extension = extname(base);
  const withoutExtension = extension ? base.slice(0, -extension.length) : base;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];

  if ([".js", ".mjs", ".jsx"].includes(extension)) {
    candidates.unshift(`${withoutExtension}.ts`, `${withoutExtension}.tsx`);
  }

  const found = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (!found) {
    throw new Error(
      `cannot resolve local import ${JSON.stringify(specifier)} from ${importerPath}`,
    );
  }

  return resolve(found);
}

function importReferences(sourceFile) {
  const references = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      references.push(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.moduleSpecifier) references.push(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      references.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

export function localRuntimeImports(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".js") || filePath.endsWith(".mjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS,
  );
  return importReferences(sourceFile)
    .map((specifier) => specifier.text)
    .filter(isRelativeSpecifier);
}

function applyEdits(source, edits) {
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function analyzeImports(filePath, source, rootDirectory) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".js") || filePath.endsWith(".mjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS,
  );
  const dependencies = new Map();
  const packageImports = new Set();
  const edits = [];

  for (const specifierNode of importReferences(sourceFile)) {
    const specifier = specifierNode.text;
    if (!isRelativeSpecifier(specifier)) {
      if (!isNodeBuiltin(specifier) && !specifier.startsWith("jsinsqlite:")) {
        packageImports.add(specifier);
      }
      continue;
    }

    const dependencyPath = resolveLocalImport(specifier, filePath);
    const moduleKey = moduleKeyFor(dependencyPath, rootDirectory);
    dependencies.set(dependencyPath, moduleKey);

    const literal = source.slice(specifierNode.getStart(), specifierNode.end);
    const quote = literal[0];
    edits.push({
      start: specifierNode.getStart(),
      end: specifierNode.end,
      text: `${quote}jsinsqlite:${moduleKey}${quote}`,
    });
  }

  return {
    source: applyEdits(source, edits),
    dependencies,
    packageImports,
  };
}

function declarationName(statement) {
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.text;
  }

  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) return declaration.name.text;
    }
  }

  return undefined;
}

function declarationKind(statement) {
  if (ts.isFunctionDeclaration(statement)) return "function";
  if (ts.isClassDeclaration(statement)) return "class";
  if (
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return "type";
  }
  if (ts.isVariableStatement(statement)) return "constant";
  return undefined;
}

function uniqueEntryKey(base, usedKeys) {
  let key = base;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${base}-${suffix}`;
    suffix += 1;
  }
  usedKeys.add(key);
  return key;
}

function preserveLeadingLines(text) {
  const newlineCount = text.match(/\n/g)?.length ?? 0;
  return "\n".repeat(newlineCount);
}

function splitModuleSource(
  filePath,
  moduleKey,
  rewrittenSource,
  rootDirectory,
  versionMetadata,
) {
  const sourceFile = ts.createSourceFile(
    filePath,
    rewrittenSource,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".js") || filePath.endsWith(".mjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS,
  );
  const entries = [];
  const edits = [];
  const usedKeys = new Set(["main"]);

  for (const statement of sourceFile.statements) {
    const kind = declarationKind(statement);
    if (!kind) continue;

    const name = declarationName(statement);
    if (!name) continue;

    const start = statement.getFullStart();
    const statementStart = statement.getStart(sourceFile);
    const leading = rewrittenSource.slice(start, statementStart);
    const slot = entries.length;
    const source = rewrittenSource.slice(start, statement.end).trim();
    const key = uniqueEntryKey(name, usedKeys);

    entries.push({
      key,
      kind,
      source,
    });
    edits.push({
      start,
      end: statement.end,
      text: `${preserveLeadingLines(leading)}/* @ref:${slot} */`,
    });
  }

  const mainSource = applyEdits(rewrittenSource, edits).trim();
  const sourcePath = relative(rootDirectory, filePath).split(sep).join("/");
  const refs = entries.map((entry, slot) => ({
    slot,
    entry: entry.key,
  }));

  return {
    key: moduleKey,
    description: `Imported from ${sourcePath}`,
    versions: [
      {
        ...versionMetadata,
        format: sourceFormat(filePath),
        sourcePath,
        entries: [
          {
            key: "main",
            kind: "module",
            source: mainSource,
            refs,
          },
          ...entries,
        ],
      },
    ],
  };
}

export function collectModuleGraph(entryPath, options = {}) {
  const rootPath = resolve(entryPath);
  if (!existsSync(rootPath)) {
    throw new Error(`source module does not exist: ${rootPath}`);
  }

  const rootDirectory = dirname(rootPath);
  const rootModuleKey = options.moduleKey ?? basename(rootPath, extname(rootPath));
  const versionMetadata = {
    version: options.version ?? "local",
    tag: options.tag,
    sourceRevision: options.sourceRevision,
    createdAt: options.createdAt,
  };
  const modulesByPath = new Map();
  const pathsByKey = new Map();
  const modules = [];
  const packageImports = new Set();

  function visit(filePath, moduleKey) {
    if (modulesByPath.has(filePath)) return;
    const existingPath = pathsByKey.get(moduleKey);
    if (existingPath !== undefined && existingPath !== filePath) {
      throw new Error(
        `two source files map to module ${moduleKey}: ${existingPath}, ${filePath}`,
      );
    }

    modulesByPath.set(filePath, moduleKey);
    pathsByKey.set(moduleKey, filePath);

    const source = readFileSync(filePath, "utf8");
    const analysis = analyzeImports(filePath, source, rootDirectory);
    for (const specifier of analysis.packageImports) {
      packageImports.add(specifier);
    }
    for (const [dependencyPath, dependencyKey] of analysis.dependencies) {
      visit(dependencyPath, dependencyKey);
    }

    modules.push(
      splitModuleSource(
        filePath,
        moduleKey,
        analysis.source,
        rootDirectory,
        versionMetadata,
      ),
    );
  }

  visit(rootPath, rootModuleKey);
  return {
    manifest: { modules },
    packageImports: [...packageImports].sort(),
  };
}

export function mergeModuleGraphs(graphs) {
  const modules = new Map();

  for (const graph of graphs) {
    for (const sourceModule of graph.manifest.modules) {
      let module = modules.get(sourceModule.key);
      if (!module) {
        module = {
          key: sourceModule.key,
          description: sourceModule.description,
          versions: [],
        };
        modules.set(sourceModule.key, module);
      }
      module.versions.push(...sourceModule.versions);
    }
  }

  return {
    modules: [...modules.values()],
  };
}

export function importModuleDatabase(options) {
  const graph = collectModuleGraph(options.entryPath, {
    moduleKey: options.moduleKey,
    version: options.version,
    tag: options.tag,
    sourceRevision: options.sourceRevision,
    createdAt: options.createdAt,
  });
  buildDatabase(options.databasePath, graph.manifest, {
    overwrite: options.overwrite,
  });
  return graph;
}
