import { readFile } from "node:fs/promises";
import { createPublicClient, getAddress, http, parseAbi } from "viem";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("config/monad-testnet.json", root), "utf8"));
const hosting = JSON.parse(await readFile(new URL(".openai/hosting.json", root), "utf8"));
const migration1 = await readFile(new URL("drizzle/0001_outcome.sql", root), "utf8");
const migration2 = await readFile(new URL("drizzle/0002_wallet_auth_and_chain.sql", root), "utf8");
const issues = [];

if (config.chainId !== 10143) issues.push("Unexpected chain ID");
if (hosting.d1 !== "DB") issues.push("D1 binding DB is missing");
if (hosting.r2 !== "UPLOADS") issues.push("R2 binding UPLOADS is missing");
for (const table of ["contests", "submissions", "events"]) {
  if (!migration1.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) issues.push(`Missing ${table} schema`);
}
for (const table of ["wallet_challenges", "wallet_sessions", "chain_transactions"]) {
  if (!migration2.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) issues.push(`Missing ${table} schema`);
}

const client = createPublicClient({ transport: http(config.rpcUrl) });
const escrow = getAddress(config.escrowAddress);
const abi = parseAbi([
  "function ausd() view returns (address)",
  "function platformRecipient() view returns (address)",
  "function eligibilityOracle() view returns (address)",
]);
const [chainId, code, ausd, platform, oracle] = await Promise.all([
  client.getChainId(),
  client.getCode({ address: escrow }),
  client.readContract({ address: escrow, abi, functionName: "ausd" }),
  client.readContract({ address: escrow, abi, functionName: "platformRecipient" }),
  client.readContract({ address: escrow, abi, functionName: "eligibilityOracle" }),
]);

if (chainId !== config.chainId) issues.push("RPC returned the wrong chain");
if (!code || code === "0x") issues.push("Escrow bytecode is missing");
if (getAddress(ausd) !== getAddress(config.ausdAddress)) issues.push("Escrow AUSD mismatch");
if (getAddress(platform) !== getAddress(config.platformRecipient)) issues.push("Platform recipient mismatch");
if (getAddress(oracle) !== getAddress(config.eligibilityOracle)) issues.push("Eligibility oracle mismatch");

if (issues.length) {
  console.error(JSON.stringify({ ready: false, issues }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ready: true,
    network: "Monad Testnet",
    chainId,
    escrow,
    ausd: getAddress(ausd),
    bindings: { d1: hosting.d1, r2: hosting.r2 },
    localEvaluatorSecretConfigured: Boolean(process.env.KOTAE_EVALUATOR_SECRET?.length >= 32),
    note: "Hosted secrets are managed separately in Sites and are not readable by this local check.",
  }, null, 2));
}
