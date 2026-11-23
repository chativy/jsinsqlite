import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFileRecord } from "./compiler.js";

const LOGICAL_MODULE_PREFIX = "jsqlite:";

function sqliteTarget(urlLike, parentURL) {
  let url;
  try {
    url = new URL(urlLike, parentURL);
  } catch {
    return null;
  }

  if (url.protocol !== "file:") return null;

  let databasePath;
  try {
    databasePath = fileURLToPath(url);
  } catch {
    return null;
  }
  if (extname(databasePath) !== ".sqlite") return null;

  return {
    url: url.href,
    databasePath,
    moduleKey: url.searchParams.get("module") ?? "main",
    version: url.searchParams.get("version") ?? undefined,
  };
}

function logicalSqliteTarget(specifier, parentURL) {
  if (!specifier.startsWith(LOGICAL_MODULE_PREFIX)) return null;

  const parent = sqliteTarget(parentURL);
  if (!parent) return null;

  const encodedModuleKey = specifier.slice(LOGICAL_MODULE_PREFIX.length);
  let moduleKey;
  try {
    moduleKey = decodeURIComponent(encodedModuleKey);
  } catch {
    return null;
  }
  if (moduleKey === "") return null;

  const url = new URL(parent.url);
  url.searchParams.set("module", moduleKey);
  return {
    url: url.href,
    databasePath: parent.databasePath,
    moduleKey,
    version: parent.version,
  };
}

export function resolve(specifier, context, nextResolve) {
  const target =
    sqliteTarget(specifier, context.parentURL) ??
    logicalSqliteTarget(specifier, context.parentURL);
  if (target) {
    return { url: target.url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  const target = sqliteTarget(url);
  if (!target) {
    return nextLoad(url, context);
  }

  const compiled = compileModuleFileRecord(
    target.databasePath,
    target.moduleKey,
    target.version,
  );
  return {
    format: compiled.format === "ts" ? "module-typescript" : "module",
    source: compiled.source,
    shortCircuit: true,
  };
}

