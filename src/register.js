import { register, registerHooks } from "node:module";
import { load, resolve } from "./hooks.js";

if (typeof registerHooks === "function") {
  registerHooks({ resolve, load });
} else {
  register(new URL("./hooks.js", import.meta.url).href);
}

