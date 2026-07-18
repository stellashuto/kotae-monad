import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eligibilityReasonHash } from "./chain.js";

const eligibilityAbi = parseAbi([
  "function recordEligibility(uint256 submissionId, uint8 eligibility, bytes32 reasonHash)",
]);

const objectiveResult = {
  status: "VALID",
  reasonCodes: [],
  message: "Objective file integrity, format, size, content hash, and creator attestation verified.",
};

function oracleAccount(env) {
  const privateKey = String(env.ELIGIBILITY_ORACLE_PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("Independent eligibility Oracle signer is not configured");
  const account = privateKeyToAccount(privateKey);
  const configured = String(env.ELIGIBILITY_ORACLE || "").trim();
  if (!isAddress(configured, { strict: false }) || getAddress(configured) !== account.address) {
    throw new Error("Eligibility Oracle signer does not match the configured Oracle address");
  }
  return account;
}

export async function recordObjectiveEligibility(env, chainSubmissionId) {
  if (!isAddress(env.KOTAE_ESCROW_ADDRESS || "", { strict: false }) || !env.MONAD_RPC_URL) {
    throw new Error("Monad Oracle transaction is not configured");
  }
  const account = oracleAccount(env);
  const chain = defineChain({
    id: 10143,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [env.MONAD_RPC_URL] } },
  });
  const transport = http(env.MONAD_RPC_URL);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  const reasonHash = eligibilityReasonHash(objectiveResult);
  const txHash = await walletClient.writeContract({
    address: getAddress(env.KOTAE_ESCROW_ADDRESS),
    abi: eligibilityAbi,
    functionName: "recordEligibility",
    args: [BigInt(chainSubmissionId), 1, reasonHash],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("Independent Oracle transaction reverted");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const finalized = await publicClient.getBlock({ blockTag: "finalized" });
    if (finalized.number >= receipt.blockNumber) {
      return {
        ...objectiveResult,
        actor: account.address.toLowerCase(),
        txHash: txHash.toLowerCase(),
        blockNumber: String(receipt.blockNumber),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Independent Oracle transaction is awaiting finality");
}
