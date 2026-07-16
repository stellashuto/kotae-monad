import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "public"), dist, { recursive: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await cp(resolve(root, "worker", "index.js"), resolve(dist, "server", "index.js"));
console.log("KOTAE built to dist/");
