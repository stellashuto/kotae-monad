import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, formatUnits, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secret = JSON.parse(await readFile(resolve(root, ".secrets", "demo-creator.json"), "utf8"));
const config = JSON.parse(await readFile(resolve(root, "config", "monad-testnet.json"), "utf8"));
const imagePath = resolve(root, "assets", "submissions", "kotae-spark-launch-1200.png");
const image = await readFile(imagePath);
const account = privateKeyToAccount(secret.privateKey);
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz/"] } } });
const transport = http(chain.rpcUrls.default.http[0]);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const ausd = config.ausdAddress;
const faucet = config.ausdFaucetAddress;
const escrow = config.escrowAddress;
const baseUrl = "https://kotae-monad-spark.vercel.app";
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const faucetAbi = parseAbi(["function requestFunds(address recipient)"]);
const escrowAbi = parseAbi(["function submitWork(uint256 contestId, bytes32 contentHash) returns (uint256 submissionId)"]);

const contestsResponse = await fetch(`${baseUrl}/api/contests`);
const contestsPayload = await contestsResponse.json();
if (!contestsResponse.ok) throw new Error(contestsPayload.error || "Live contests could not be loaded");
const contest = contestsPayload.contests.find((item) => item.status === "OPEN" && item.title === "KOTAE Spark launch visual") || contestsPayload.contests.find((item) => item.status === "OPEN");
if (!contest?.id || !contest?.chainContestId) throw new Error("Create the replacement KOTAE contest on the separated escrow first");

async function waitFinalized(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const finalized = await publicClient.getBlock({ blockTag: "finalized" });
    if (finalized.number >= receipt.blockNumber) return receipt;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`Transaction ${hash} did not finalize in time`);
}

async function walletSession() {
  const challengeResponse = await fetch(`${baseUrl}/api/auth/challenge`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ address: account.address }) });
  const challenge = await challengeResponse.json();
  if (!challengeResponse.ok) throw new Error(challenge.error || "Wallet challenge failed");
  const signature = await account.signMessage({ message: challenge.message });
  const verifyResponse = await fetch(`${baseUrl}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ challengeId: challenge.challengeId, address: account.address, signature }) });
  const verified = await verifyResponse.json();
  if (!verifyResponse.ok) throw new Error(verified.error || "Wallet verification failed");
  const cookie = verifyResponse.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Wallet session cookie was not returned");
  return cookie;
}

let monBalance = await publicClient.getBalance({ address: account.address });
if (monBalance === 0n) {
  console.log(JSON.stringify({ ready: false, address: account.address, mon: "0", ausd: "0", action: "fund_mon" }));
  process.exit(2);
}

let ausdBalance = await publicClient.readContract({ address: ausd, abi: erc20, functionName: "balanceOf", args: [account.address] });
if (ausdBalance < parseUnits("0.5", 6)) {
  const faucetHash = await walletClient.writeContract({ address: faucet, abi: faucetAbi, functionName: "requestFunds", args: [account.address] });
  await waitFinalized(faucetHash);
  ausdBalance = await publicClient.readContract({ address: ausd, abi: erc20, functionName: "balanceOf", args: [account.address] });
}

const approveHash = await walletClient.writeContract({ address: ausd, abi: erc20, functionName: "approve", args: [escrow, parseUnits("0.5", 6)] });
await waitFinalized(approveHash);
const contentHash = `0x${createHash("sha256").update(image).digest("hex")}`;
const submitHash = await walletClient.writeContract({ address: escrow, abi: escrowAbi, functionName: "submitWork", args: [BigInt(contest.chainContestId), contentHash] });
await waitFinalized(submitHash);

const cookie = await walletSession();
const form = new FormData();
form.append("file", new File([image], "kotae-spark-launch-1200.png", { type: "image/png" }));
form.append("txHash", submitHash);
const uploadResponse = await fetch(`${baseUrl}/api/contests/${encodeURIComponent(contest.id)}/submissions`, { method: "POST", headers: { cookie, origin: baseUrl, "x-wallet-address": account.address }, body: form });
const upload = await uploadResponse.json();
if (!uploadResponse.ok) throw new Error(upload.error || "Submission upload failed");

monBalance = await publicClient.getBalance({ address: account.address });
ausdBalance = await publicClient.readContract({ address: ausd, abi: erc20, functionName: "balanceOf", args: [account.address] });
console.log(JSON.stringify({ ready: true, address: account.address, mon: formatEther(monBalance), ausd: formatUnits(ausdBalance, 6), contestId: contest.id, chainContestId: contest.chainContestId, approveHash, submitHash, submissionId: upload.submissionId, chainSubmissionId: upload.chainSubmissionId, oracleTxHash: upload.oracleTxHash, eligibility: upload.eligibility, contentHash }));
