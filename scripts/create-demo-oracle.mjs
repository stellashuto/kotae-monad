import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secretDir = resolve(root, ".secrets");
const secretPath = resolve(secretDir, "demo-oracle.json");

if (existsSync(secretPath)) {
  const saved = JSON.parse(await readFile(secretPath, "utf8"));
  const account = privateKeyToAccount(saved.privateKey);
  console.log(JSON.stringify({ created: false, address: account.address }));
  process.exit(0);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
await mkdir(secretDir, { recursive: true });
await writeFile(secretPath, `${JSON.stringify({ address: account.address, privateKey }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({ created: true, address: account.address }));
