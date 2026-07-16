import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  authenticatedWallet,
  buildWalletMessage,
  createWalletChallenge,
  verifyWalletChallenge,
  verifyWalletSignature,
} from "../worker/auth.js";
import { ChainVerificationError, contestBriefHash, verifyEscrowTransaction } from "../worker/chain.js";

const testAccount = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

class AuthDatabase {
  constructor() {
    this.challenges = new Map();
    this.sessions = new Map();
  }

  prepare(sql) {
    const database = this;
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.startsWith("SELECT id,address,origin,message")) return database.challenges.get(this.values[0]) || null;
        if (sql.startsWith("SELECT address,expires_at FROM wallet_sessions")) {
          const session = database.sessions.get(this.values[0]);
          return session && session.expires_at > this.values[1] ? session : null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("DELETE FROM wallet_challenges")) {
          const [now, address] = this.values;
          for (const [id, item] of database.challenges) if (item.expires_at <= now || (item.address === address && !item.used_at)) database.challenges.delete(id);
        } else if (sql.startsWith("INSERT INTO wallet_challenges")) {
          const [id,address,origin,nonce,message,expires_at,created_at] = this.values;
          database.challenges.set(id,{id,address,origin,nonce,message,expires_at,created_at,used_at:null});
        } else if (sql.startsWith("UPDATE wallet_challenges SET used_at")) {
          const [usedAt,id] = this.values, item = database.challenges.get(id);
          if (!item || item.used_at) return { meta: { changes: 0 } };
          item.used_at = usedAt;
          return { meta: { changes: 1 } };
        } else if (sql.startsWith("DELETE FROM wallet_sessions WHERE expires_at")) {
          const [now] = this.values;
          for (const [tokenHash, item] of database.sessions) if (item.expires_at <= now) database.sessions.delete(tokenHash);
        } else if (sql.startsWith("INSERT INTO wallet_sessions")) {
          const [token_hash,address,expires_at,created_at,last_seen_at] = this.values;
          database.sessions.set(token_hash,{token_hash,address,expires_at,created_at,last_seen_at});
        } else if (sql.startsWith("UPDATE wallet_sessions SET last_seen_at")) {
          const [lastSeen,tokenHash] = this.values, item = database.sessions.get(tokenHash);
          if (item) item.last_seen_at = lastSeen;
        }
        return { meta: { changes: 1 } };
      }
    };
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

test("wallet challenge verifies the intended EIP-191 signer and rejects another address", async () => {
  const message = buildWalletMessage({
    origin: "https://kotae.test",
    address: testAccount.address,
    nonce: "0123456789abcdef0123456789abcdef",
    issuedAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-16T00:05:00.000Z",
  });
  const signature = await testAccount.signMessage({ message });
  assert.equal(await verifyWalletSignature({ address: testAccount.address, message, signature }), true);
  assert.equal(await verifyWalletSignature({ address: "0x000000000000000000000000000000000000dEaD", message, signature }), false);
  assert.match(message, /Chain ID: 10143/);
  assert.match(message, /does not trigger a blockchain transaction/);
});

test("wallet challenge creates a server session once and rejects replay", async () => {
  const database = new AuthDatabase();
  const origin = "https://kotae.test";
  const challengeResponse = await createWalletChallenge(new Request(`${origin}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ address: testAccount.address }),
  }), database);
  assert.equal(challengeResponse.status, 201);
  const challenge = await challengeResponse.json();
  const signature = await testAccount.signMessage({ message: challenge.message });
  const verificationRequest = () => new Request(`${origin}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ challengeId: challenge.challengeId, address: testAccount.address, signature }),
  });
  const verified = await verifyWalletChallenge(verificationRequest(), database);
  assert.equal(verified.status, 200);
  assert.match(verified.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const cookie = verified.headers.get("set-cookie").split(";", 1)[0];
  const sessionWallet = await authenticatedWallet(new Request(`${origin}/api/auth/session`, { headers: { cookie } }), {}, database, { requireOrigin: false });
  assert.equal(sessionWallet, testAccount.address.toLowerCase());
  assert.equal((await verifyWalletChallenge(verificationRequest(), database)).status, 409);
});

test("contest brief hashing is deterministic and covers outcome requirements", () => {
  const brief = { title: "Launch poster", brief: "Make it vivid", must: ["Square"], avoid: ["Price claims"] };
  assert.equal(contestBriefHash(brief), contestBriefHash({ ...brief }));
  assert.notEqual(contestBriefHash(brief), contestBriefHash({ ...brief, must: ["Portrait"] }));
});

test("Monad receipt verification checks chain, finality, signer, escrow, and event", async () => {
  const escrow = "0x1000000000000000000000000000000000000001";
  const txHash = `0x${"12".repeat(32)}`;
  const eventAbi = parseAbi(["event ContestCreated(uint256 indexed contestId, address indexed requester, uint8 assetType, uint256 budget, uint256 deadline, bytes32 briefHash)"]);
  const topics = encodeEventTopics({ abi: eventAbi, eventName: "ContestCreated", args: { contestId: 7n, requester: testAccount.address } });
  const briefHash = `0x${"34".repeat(32)}`;
  const data = encodeAbiParameters(parseAbiParameters("uint8, uint256, uint256, bytes32"), [0, 12_000_000n, 2_000_000_000n, briefHash]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = {
      eth_chainId: "0x279f",
      eth_getTransactionByHash: { hash: txHash, from: testAccount.address, to: escrow },
      eth_getTransactionReceipt: { transactionHash: txHash, status: "0x1", to: escrow, blockNumber: "0x10", logs: [{ address: escrow, topics, data }] },
      eth_getBlockByNumber: { number: "0x11" },
    }[method];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  };
  try {
    const verified = await verifyEscrowTransaction({ MONAD_RPC_URL: "https://rpc.test", KOTAE_ESCROW_ADDRESS: escrow }, {
      txHash,
      actor: testAccount.address,
      eventName: "ContestCreated",
    });
    assert.equal(verified.args.contestId, 7n);
    assert.equal(verified.args.briefHash, briefHash);
    await assert.rejects(
      () => verifyEscrowTransaction({ MONAD_RPC_URL: "https://rpc.test", KOTAE_ESCROW_ADDRESS: escrow }, { txHash, actor: "0x000000000000000000000000000000000000dEaD", eventName: "ContestCreated" }),
      (error) => error instanceof ChainVerificationError && error.status === 403
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
