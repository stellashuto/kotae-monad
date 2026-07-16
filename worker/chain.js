import { decodeEventLog, getAddress, isAddress, keccak256, parseAbi, stringToHex } from "viem";

const MONAD_TESTNET_CHAIN_ID = "0x279f";
const txHashPattern = /^0x[0-9a-fA-F]{64}$/;

const escrowEvents = parseAbi([
  "event ContestCreated(uint256 indexed contestId, address indexed requester, uint8 assetType, uint256 budget, uint256 deadline, bytes32 briefHash)",
  "event SlotsAdded(uint256 indexed contestId, uint16 newValidCap, uint256 fee)",
  "event ContestCancelled(uint256 indexed contestId, uint256 refund)",
  "event WorkSubmitted(uint256 indexed contestId, uint256 indexed submissionId, address indexed creator, uint8 version, bytes32 contentHash)",
  "event EligibilityRecorded(uint256 indexed contestId, uint256 indexed submissionId, uint8 eligibility, bytes32 reasonHash)",
  "event ContestSettled(uint256 indexed contestId, uint256 indexed winnerSubmissionId, uint256 winnerAmount, uint256 participationPool, uint256 platformAmount)",
  "event TimeoutSettlement(uint256 indexed contestId, uint16 validCount, uint256 creatorPool, uint256 requesterRefund, uint256 platformAmount)",
]);

export class ChainVerificationError extends Error {
  constructor(message, status = 422, code = "CHAIN_TRANSACTION_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const rpc = async (url, method, params = []) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  if (!response.ok) throw new ChainVerificationError("Monad RPC is unavailable", 503, "MONAD_RPC_UNAVAILABLE");
  const payload = await response.json();
  if (payload.error) throw new ChainVerificationError("Monad RPC rejected the verification request", 503, "MONAD_RPC_ERROR");
  return payload.result;
};

const sameAddress = (left, right) => Boolean(left && right && left.toLowerCase() === right.toLowerCase());
const asBigInt = (value) => BigInt(value);

export function contestBriefHash(body) {
  const canonical = JSON.stringify({
    title: String(body.title || "").trim(),
    brief: String(body.brief || "").trim(),
    must: Array.isArray(body.must) ? body.must.map(String) : [],
    avoid: Array.isArray(body.avoid) ? body.avoid.map(String) : [],
  });
  return keccak256(stringToHex(canonical));
}

export function eligibilityReasonHash(body) {
  return keccak256(stringToHex(JSON.stringify({
    reasonCodes: Array.isArray(body.reasonCodes) ? body.reasonCodes.map(String) : [],
    message: body.message ? String(body.message) : null,
  })));
}

export async function verifyEscrowTransaction(env, { txHash, actor, eventName }) {
  if (!txHashPattern.test(txHash || "")) throw new ChainVerificationError("A valid Monad transaction hash is required");
  if (!env.MONAD_RPC_URL || !isAddress(env.KOTAE_ESCROW_ADDRESS || "", { strict: false })) {
    throw new ChainVerificationError("Monad transaction verification is not configured", 503, "CHAIN_VERIFICATION_NOT_CONFIGURED");
  }
  const escrow = getAddress(env.KOTAE_ESCROW_ADDRESS);
  let chainId;
  let transaction;
  let receipt;
  let finalized;
  try {
    [chainId, transaction, receipt, finalized] = await Promise.all([
      rpc(env.MONAD_RPC_URL, "eth_chainId"),
      rpc(env.MONAD_RPC_URL, "eth_getTransactionByHash", [txHash]),
      rpc(env.MONAD_RPC_URL, "eth_getTransactionReceipt", [txHash]),
      rpc(env.MONAD_RPC_URL, "eth_getBlockByNumber", ["finalized", false]),
    ]);
  } catch (error) {
    if (error instanceof ChainVerificationError) throw error;
    throw new ChainVerificationError("Monad RPC is unavailable", 503, "MONAD_RPC_UNAVAILABLE");
  }
  if (String(chainId).toLowerCase() !== MONAD_TESTNET_CHAIN_ID) throw new ChainVerificationError("Transaction is not on Monad Testnet");
  if (!transaction || !receipt) throw new ChainVerificationError("Transaction is not mined yet", 409, "CHAIN_TRANSACTION_PENDING");
  if (receipt.status !== "0x1") throw new ChainVerificationError("Transaction reverted onchain");
  if (!sameAddress(transaction.to, escrow) || !sameAddress(receipt.to, escrow)) throw new ChainVerificationError("Transaction did not call the configured KOTAE escrow");
  if (actor && !sameAddress(transaction.from, actor)) throw new ChainVerificationError("Transaction signer does not match the authenticated wallet", 403);
  if (!finalized?.number || asBigInt(receipt.blockNumber) > asBigInt(finalized.number)) throw new ChainVerificationError("Transaction is awaiting finality", 409, "CHAIN_TRANSACTION_NOT_FINAL");
  let event;
  for (const log of receipt.logs || []) {
    if (!sameAddress(log.address, escrow)) continue;
    try {
      const decoded = decodeEventLog({ abi: escrowEvents, data: log.data, topics: log.topics, strict: true });
      if (decoded.eventName === eventName) { event = decoded; break; }
    } catch {
      // Ignore unrelated escrow logs.
    }
  }
  if (!event) throw new ChainVerificationError(`Transaction is missing the ${eventName} event`);
  return { txHash: txHash.toLowerCase(), transaction, receipt, args: event.args };
}

export const assetTypeCode = {
  "Photo / Visual": 0n,
  "Static Page": 1n,
  "Micro Tool": 2n,
  "Short Video": 3n,
};
