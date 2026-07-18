import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, formatUnits, http, keccak256, parseAbi, parseEther, parseUnits, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [requesterSecret, creatorSecret, config] = await Promise.all([
  readFile(resolve(root, ".secrets", "demo-requester.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, ".secrets", "demo-creator.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "config", "monad-testnet.json"), "utf8").then(JSON.parse),
]);
const requester = privateKeyToAccount(requesterSecret.privateKey);
const funder = privateKeyToAccount(creatorSecret.privateKey);
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
const transport = http(config.rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const requesterClient = createWalletClient({ account: requester, chain, transport });
const funderClient = createWalletClient({ account: funder, chain, transport });
const baseUrl = "https://kotae-monad-spark.vercel.app";
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"]);
const escrowAbi = parseAbi(["function createContest(uint8 assetType, uint128 baseBudget, uint40 submissionDeadline, uint16 validCap, bytes32 briefHash) returns (uint256 contestId)"]);

async function waitFinalized(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const finalized = await publicClient.getBlock({ blockTag: "finalized" });
    if (finalized.number >= receipt.blockNumber) return receipt;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Transaction ${hash} did not finalize in time`);
}

async function walletSession() {
  const challengeResponse = await fetch(`${baseUrl}/api/auth/challenge`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ address: requester.address }) });
  const challenge = await challengeResponse.json();
  if (!challengeResponse.ok) throw new Error(challenge.error || "Wallet challenge failed");
  const signature = await requester.signMessage({ message: challenge.message });
  const verifyResponse = await fetch(`${baseUrl}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ challengeId: challenge.challengeId, address: requester.address, signature }) });
  const verified = await verifyResponse.json();
  if (!verifyResponse.ok) throw new Error(verified.error || "Wallet verification failed");
  const cookie = verifyResponse.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Wallet session cookie was not returned");
  return cookie;
}

let monBalance = await publicClient.getBalance({ address: requester.address });
let fundingHash = null;
if (monBalance < parseEther("0.2")) {
  fundingHash = await funderClient.sendTransaction({ to: requester.address, value: parseEther("0.5") });
  await waitFinalized(fundingHash);
  monBalance = await publicClient.getBalance({ address: requester.address });
}

let ausdBalance = await publicClient.readContract({ address: config.ausdAddress, abi: erc20, functionName: "balanceOf", args: [requester.address] });
let ausdFundingHash = null;
if (ausdBalance < parseUnits("3", 6)) {
  ausdFundingHash = await funderClient.writeContract({ address: config.ausdAddress, abi: erc20, functionName: "transfer", args: [requester.address, parseUnits("10", 6)] });
  await waitFinalized(ausdFundingHash);
  ausdBalance = await publicClient.readContract({ address: config.ausdAddress, abi: erc20, functionName: "balanceOf", args: [requester.address] });
}

const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60);
const deadlineAt = new Date(Number(deadlineSeconds) * 1000).toISOString();
const contest = {
  title: "KOTAE Spark launch visual",
  type: "Photo / Visual",
  brief: "Create one square launch graphic for my KOTAE Spark submission and social post. Explain the practical value at a glance: buyers fund a result, creators submit finished work, and the buyer chooses the winner. Deliver a polished 1200×1200 PNG or JPEG that is readable on mobile and feels distinct from generic crypto dashboards.",
  must: ["Explain the buyer-funded result", "Show creators submit finished work", "Show the requester chooses the winner", "Readable at mobile size"],
  avoid: ["Generic crypto dashboard styling", "Unverifiable performance claims"],
  budget: 3,
  cap: 10,
  deadlineAt,
};
const briefHash = keccak256(stringToHex(JSON.stringify({ title: contest.title, brief: contest.brief, must: contest.must, avoid: contest.avoid })));
const approveHash = await requesterClient.writeContract({ address: config.ausdAddress, abi: erc20, functionName: "approve", args: [config.escrowAddress, parseUnits("3", 6)] });
await waitFinalized(approveHash);
const contestHash = await requesterClient.writeContract({ address: config.escrowAddress, abi: escrowAbi, functionName: "createContest", args: [0, parseUnits("3", 6), deadlineSeconds, 10, briefHash] });
await waitFinalized(contestHash);

const cookie = await walletSession();
const recordResponse = await fetch(`${baseUrl}/api/contests`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: baseUrl, "x-wallet-address": requester.address }, body: JSON.stringify({ ...contest, txHash: contestHash }) });
const record = await recordResponse.json();
if (!recordResponse.ok) throw new Error(record.error || "Contest recording failed");

console.log(JSON.stringify({
  ready: true,
  requester: requester.address,
  mon: formatEther(monBalance),
  ausd: formatUnits(ausdBalance, 6),
  fundingHash,
  ausdFundingHash,
  approveHash,
  contestHash,
  contestId: record.contest.id,
  chainContestId: record.contest.chainContestId,
  deadlineAt,
}));
