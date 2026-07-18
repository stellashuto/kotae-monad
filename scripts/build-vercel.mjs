import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

await import("./build.mjs");

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "dist");
const output = resolve(root, "vercel-dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js", "og.png"]) {
  await copyFile(resolve(source, file), resolve(output, file));
}
await copyFile(resolve(source, "kotae-demo.mp4"), resolve(output, "kotae-demo-v15.mp4"));
console.log("KOTAE Vercel frontend built to vercel-dist/");
