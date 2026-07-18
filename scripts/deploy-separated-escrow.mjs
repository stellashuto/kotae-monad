import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secret = JSON.parse(await readFile(resolve(root, ".secrets", "demo-oracle.json"), "utf8"));
const artifact = JSON.parse(await readFile(resolve(root, "artifacts", "contracts", "src", "KotaeEscrow.sol", "KotaeEscrow.json"), "utf8"));
const config = JSON.parse(await readFile(resolve(root, "config", "monad-testnet.json"), "utf8"));
const account = privateKeyToAccount(secret.privateKey);
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
const transport = http(config.rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

const hash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [getAddress(config.ausdAddress), getAddress(config.platformRecipient), account.address],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("KotaeEscrow deployment failed");

console.log(JSON.stringify({
  chainId: chain.id,
  contract: receipt.contractAddress,
  deploymentTxHash: hash,
  deploymentBlock: Number(receipt.blockNumber),
  oracle: account.address,
}));
