import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "public"), dist, { recursive: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await build({
  entryPoints: [resolve(root, "public", "app.js")],
  outfile: resolve(dist, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
});
const [indexHtml, stylesCss, appJs, ogPng] = await Promise.all([
  readFile(resolve(root, "public", "index.html"), "utf8"),
  readFile(resolve(root, "public", "styles.css"), "utf8"),
  readFile(resolve(dist, "app.js"), "utf8"),
  readFile(resolve(root, "public", "og.png")),
]);
const embeddedStaticAssets = {
  "/index.html": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/styles.css": { body: stylesCss, contentType: "text/css; charset=utf-8" },
  "/app.js": { body: appJs, contentType: "text/javascript; charset=utf-8" },
  "/og.png": { body: ogPng.toString("base64"), contentType: "image/png", encoding: "base64" },
};
await build({
  entryPoints: [resolve(root, "worker", "index.js")],
  outfile: resolve(dist, "server", "index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["worker", "browser"],
  define: {
    "globalThis.__KOTAE_STATIC_ASSETS__": JSON.stringify(embeddedStaticAssets),
  },
  logLevel: "warning",
});
console.log("KOTAE built to dist/");
