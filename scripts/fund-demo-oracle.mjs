import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [creatorSecret, oracleSecret, config] = await Promise.all([
  readFile(resolve(root, ".secrets", "demo-creator.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, ".secrets", "demo-oracle.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "config", "monad-testnet.json"), "utf8").then(JSON.parse),
]);
const creator = privateKeyToAccount(creatorSecret.privateKey);
const oracle = privateKeyToAccount(oracleSecret.privateKey);
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
const transport = http(config.rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account: creator, chain, transport });
const current = await publicClient.getBalance({ address: oracle.address });

if (current >= parseEther("0.5")) {
  console.log(JSON.stringify({ transferred: false, oracle: oracle.address, balance: formatEther(current) }));
  process.exit(0);
}

const hash = await walletClient.sendTransaction({ to: oracle.address, value: parseEther("1") });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error("Oracle funding transaction failed");
const balance = await publicClient.getBalance({ address: oracle.address });
console.log(JSON.stringify({ transferred: true, oracle: oracle.address, balance: formatEther(balance), txHash: hash }));
