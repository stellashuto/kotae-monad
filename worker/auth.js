import { getAddress, isAddress, verifyMessage } from "viem";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const walletAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const signaturePattern = /^0x[0-9a-fA-F]{130}$/;

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
});

const randomHex = (bytes) => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const sha256 = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const cookieValue = (request, name) => {
  const cookies = request.headers.get("cookie") || "";
  for (const item of cookies.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return null;
};

const sameOrigin = (request) => {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
};

const sessionCookie = (request, token, maxAge = SESSION_TTL_SECONDS) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `kotae_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
};

export function buildWalletMessage({ origin, address, nonce, issuedAt, expiresAt }) {
  return [
    "KOTAE wants you to verify ownership of this wallet.",
    "",
    `Origin: ${origin}`,
    `Address: ${getAddress(address)}`,
    "Chain ID: 10143",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
    "",
    "This request does not trigger a blockchain transaction or cost gas.",
  ].join("\n");
}

export async function verifyWalletSignature({ address, message, signature }) {
  if (!isAddress(address, { strict: false }) || !signaturePattern.test(signature || "")) return false;
  try {
    return await verifyMessage({ address: getAddress(address), message, signature });
  } catch {
    return false;
  }
}

export async function createWalletChallenge(request, database) {
  if (!sameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const body = await request.json().catch(() => ({}));
  if (!isAddress(String(body.address || ""), { strict: false })) return json({ error: "A valid wallet address is required" }, 422);
  const address = getAddress(body.address).toLowerCase();
  const origin = new URL(request.url).origin;
  const now = new Date();
  const expires = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const challengeId = `challenge_${crypto.randomUUID().replaceAll("-", "")}`;
  const nonce = randomHex(16);
  const issuedAt = now.toISOString();
  const expiresAt = expires.toISOString();
  const message = buildWalletMessage({ origin, address, nonce, issuedAt, expiresAt });
  await database.batch([
    database.prepare(`DELETE FROM wallet_challenges WHERE expires_at <= ? OR (address=? AND used_at IS NULL)`).bind(issuedAt, address),
    database.prepare(`INSERT INTO wallet_challenges (id,address,origin,nonce,message,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).bind(challengeId,address,origin,nonce,message,expiresAt,issuedAt),
  ]);
  return json({ challengeId, address, message, expiresAt }, 201, { "cache-control": "no-store" });
}

export async function verifyWalletChallenge(request, database) {
  if (!sameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const body = await request.json().catch(() => ({}));
  const challengeId = String(body.challengeId || "");
  const address = String(body.address || "");
  const signature = String(body.signature || "");
  if (!challengeId || !isAddress(address, { strict: false }) || !signaturePattern.test(signature)) return json({ error: "Invalid verification payload" }, 422);
  const normalizedAddress = getAddress(address).toLowerCase();
  const challenge = await database.prepare(`SELECT id,address,origin,message,expires_at,used_at FROM wallet_challenges WHERE id=?`).bind(challengeId).first();
  const now = new Date().toISOString();
  if (!challenge || challenge.used_at || challenge.address !== normalizedAddress || challenge.origin !== new URL(request.url).origin || challenge.expires_at <= now) {
    return json({ error: "Challenge is invalid or expired" }, 409);
  }
  if (!(await verifyWalletSignature({ address: normalizedAddress, message: challenge.message, signature }))) return json({ error: "Wallet signature is invalid" }, 401);
  const claimed = await database.prepare(`UPDATE wallet_challenges SET used_at=? WHERE id=? AND used_at IS NULL`).bind(now, challengeId).run();
  if (Number(claimed?.meta?.changes || 0) !== 1) return json({ error: "Challenge has already been used" }, 409);
  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await database.batch([
    database.prepare(`DELETE FROM wallet_sessions WHERE expires_at <= ?`).bind(now),
    database.prepare(`INSERT INTO wallet_sessions (token_hash,address,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?)`).bind(tokenHash,normalizedAddress,expiresAt,now,now),
  ]);
  return json({ address: normalizedAddress, expiresAt }, 200, {
    "cache-control": "no-store",
    "set-cookie": sessionCookie(request, token),
  });
}

export async function authenticatedWallet(request, env, database, { requireOrigin = true } = {}) {
  if (env.KOTAE_AUTH_MODE === "demo") {
    const address = request.headers.get("x-wallet-address");
    if (!address || !walletAddressPattern.test(address)) return json({ error: "A valid demo wallet address is required" }, 401);
    return address.toLowerCase();
  }
  if (requireOrigin && !sameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const token = cookieValue(request, "kotae_session");
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return json({ error: "Wallet signature verification is required", code: "WALLET_AUTH_REQUIRED" }, 401);
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const session = await database.prepare(`SELECT address,expires_at FROM wallet_sessions WHERE token_hash=? AND expires_at>?`).bind(tokenHash,now).first();
  if (!session) return json({ error: "Wallet session is invalid or expired", code: "WALLET_SESSION_EXPIRED" }, 401);
  await database.prepare(`UPDATE wallet_sessions SET last_seen_at=? WHERE token_hash=?`).bind(now,tokenHash).run();
  return session.address;
}

export async function walletSession(request, env, database) {
  const wallet = await authenticatedWallet(request, env, database, { requireOrigin: false });
  if (wallet instanceof Response) return wallet;
  return json({ address: wallet }, 200, { "cache-control": "no-store" });
}

export async function logoutWallet(request, database) {
  if (!sameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const token = cookieValue(request, "kotae_session");
  if (token && /^[0-9a-f]{64}$/.test(token)) await database.prepare(`DELETE FROM wallet_sessions WHERE token_hash=?`).bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0), "cache-control": "no-store" });
}
