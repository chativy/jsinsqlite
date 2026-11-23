import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFile } from "./compiler.js";

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
  };
}

export function resolve(specifier, context, nextResolve) {
  const target = sqliteTarget(specifier, context.parentURL);
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

  return {
    format: "module",
    source: compileModuleFile(target.databasePath, target.moduleKey),
    shortCircuit: true,
  };
}

