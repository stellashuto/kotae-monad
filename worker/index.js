import { schemaStatements } from "../db/schema.ts";
import {
  authenticatedWallet,
  createWalletChallenge,
  logoutWallet,
  verifyWalletChallenge,
  walletSession,
} from "./auth.js";
import {
  assetTypeCode,
  ChainVerificationError,
  contestBriefHash,
  eligibilityReasonHash,
  verifyEscrowTransaction,
} from "./chain.js";

const initializedBindings = new WeakSet();
async function db(env) {
  if (!env.DB) throw new Error("D1 binding DB is required");
  if (!initializedBindings.has(env.DB)) {
    await env.DB.batch(schemaStatements.map((sql) => env.DB.prepare(sql)));
    initializedBindings.add(env.DB);
  }
  return env.DB;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});
const makeId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const asBigInt = (value) => BigInt(value);
const sameHex = (left, right) => String(left || "").toLowerCase() === String(right || "").toLowerCase();

function secretsMatch(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

function authorizeEvaluator(request, env) {
  const expected = env.KOTAE_EVALUATOR_SECRET;
  if (typeof expected !== "string" || expected.length < 32) return json({ error: "Evaluator authentication is not configured" }, 503);
  if (!secretsMatch(request.headers.get("x-kotae-worker-secret"), expected)) return json({ error: "Unauthorized evaluator" }, 401);
  return null;
}

async function verifiedChainTransaction(env, options) {
  try {
    return await verifyEscrowTransaction(env, options);
  } catch (error) {
    if (error instanceof ChainVerificationError) return json({ error: error.message, code: error.code }, error.status);
    return json({ error: "Monad transaction verification failed", code: "CHAIN_VERIFICATION_FAILED" }, 503);
  }
}

async function rejectReusedTransaction(database, txHash) {
  const used = await database.prepare(`SELECT tx_hash FROM chain_transactions WHERE tx_hash=?`).bind(String(txHash || "").toLowerCase()).first();
  return used ? json({ error: "Transaction has already been recorded", code: "CHAIN_TRANSACTION_REUSED" }, 409) : null;
}

const chainRecord = (database, verified, actor, action, contestId, now) => database
  .prepare(`INSERT INTO chain_transactions (tx_hash,actor,action,contest_id,block_number,verified_at) VALUES (?,?,?,?,?,?)`)
  .bind(verified.txHash,actor,action,contestId || null,verified.receipt.blockNumber,now);

async function walletForWrite(request, env, database) {
  return authenticatedWallet(request, env, database);
}

async function listContests(env) {
  const database = await db(env);
  const rows = await database.prepare(`SELECT c.*, COUNT(CASE WHEN s.eligibility='VALID' THEN 1 END) valid_count, COUNT(s.id) submission_count FROM contests c LEFT JOIN submissions s ON s.contest_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`).all();
  return json({ contests: rows.results });
}

async function createContest(request, env) {
  const database = await db(env);
  const requester = await walletForWrite(request, env, database);
  if (requester instanceof Response) return requester;
  const body = await request.json().catch(() => ({}));
  const minimums = { "Photo / Visual": 2, "Short Video": 8, "Static Page": 10, "Micro Tool": 20 };
  const budget = Math.round(Number(body.budget) * 1_000_000);
  const deadlineAt = String(body.deadlineAt || "");
  const deadlineSeconds = Math.floor(Date.parse(deadlineAt) / 1000);
  const expectedCap = body.type === "Photo / Visual" ? 10 : 5;
  if (!minimums[body.type] || budget < minimums[body.type] * 1_000_000) return json({ error: "Budget below asset minimum" }, 422);
  if (!Number.isFinite(deadlineSeconds) || Number(body.cap) !== expectedCap) return json({ error: "Deadline and default valid cap are required" }, 422);
  const txHash = String(body.txHash || request.headers.get("x-funding-tx") || "");
  const reused = await rejectReusedTransaction(database, txHash);
  if (reused) return reused;
  const verified = await verifiedChainTransaction(env, { txHash, actor: requester, eventName: "ContestCreated" });
  if (verified instanceof Response) return verified;
  const expectedBriefHash = contestBriefHash(body);
  if (
    verified.args.requester.toLowerCase() !== requester ||
    asBigInt(verified.args.assetType) !== assetTypeCode[body.type] ||
    asBigInt(verified.args.budget) !== BigInt(budget) ||
    asBigInt(verified.args.deadline) !== BigInt(deadlineSeconds) ||
    !sameHex(verified.args.briefHash, expectedBriefHash)
  ) return json({ error: "Onchain contest terms do not match the submitted brief" }, 422);
  const id = makeId("contest"), now = new Date().toISOString(), chainContestId = String(verified.args.contestId);
  await database.batch([
    database.prepare(`INSERT INTO contests (id,requester,title,asset_type,brief,must_json,avoid_json,budget_micros,valid_cap,submission_deadline,status,tx_hash,chain_contest_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,requester,body.title,body.type,body.brief,JSON.stringify(body.must||[]),JSON.stringify(body.avoid||[]),budget,body.cap,deadlineAt,"OPEN",verified.txHash,chainContestId,now),
    database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(id,requester,"CONTEST_FUNDED",JSON.stringify({budget,txHash:verified.txHash,chainContestId,briefHash:expectedBriefHash}),now),
    chainRecord(database,verified,requester,"CONTEST_CREATED",id,now),
  ]);
  return json({ contest: { ...body, id, requester, chainContestId, validCount: 0, submissions: 0, status: "OPEN" }, txHash: verified.txHash }, 201);
}

async function submitWork(request, env, contestId) {
  const database = await db(env);
  const creator = await walletForWrite(request, env, database);
  if (creator instanceof Response) return creator;
  const form = await request.formData(), file = form.get("file"), txHash = String(form.get("txHash") || "");
  if (!(file instanceof File)) return json({ error: "Original file is required" }, 422);
  const contest = await database.prepare(`SELECT asset_type,valid_cap,status,chain_contest_id FROM contests WHERE id=?`).bind(contestId).first();
  if (!contest || contest.status !== "OPEN" || !contest.chain_contest_id) return json({ error: "Contest is not open" }, 409);
  const limit = contest.asset_type === "Short Video" ? 50_000_000 : contest.asset_type === "Photo / Visual" ? 20_000_000 : 10_000_000;
  if (file.size > limit) return json({ error: "File exceeds type limit" }, 413);
  if (file.size < 1024) return json({ error: "File is empty or too small" }, 422);
  const imageAllowed = ["image/png","image/jpeg","image/webp"].includes(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
  const videoAllowed = ["video/mp4","video/webm"].includes(file.type) || /\.(mp4|webm)$/i.test(file.name);
  const zipAllowed = ["application/zip","application/x-zip-compressed"].includes(file.type) || /\.zip$/i.test(file.name);
  if (contest.asset_type === "Photo / Visual" ? !imageAllowed : contest.asset_type === "Short Video" ? !videoAllowed : !zipAllowed) return json({ error: "Unsupported file format" }, 415);
  const existing = await database.prepare(`SELECT id,version,chain_submission_id FROM submissions WHERE contest_id=? AND creator=?`).bind(contestId,creator).first();
  if (existing && existing.version >= 3) return json({ error: "Replacement limit reached" }, 409);
  const submissionId = existing?.id || makeId("submission"), version = (existing?.version || 0) + 1;
  const bytes = await file.arrayBuffer(), digest = await crypto.subtle.digest("SHA-256", bytes), contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2,"0")).join("");
  const reused = await rejectReusedTransaction(database, txHash);
  if (reused) return reused;
  const verified = await verifiedChainTransaction(env, { txHash, actor: creator, eventName: "WorkSubmitted" });
  if (verified instanceof Response) return verified;
  const chainSubmissionId = String(verified.args.submissionId);
  if (
    asBigInt(verified.args.contestId) !== BigInt(contest.chain_contest_id) ||
    verified.args.creator.toLowerCase() !== creator ||
    Number(verified.args.version) !== version ||
    !sameHex(verified.args.contentHash, `0x${contentHash}`) ||
    (existing?.chain_submission_id && existing.chain_submission_id !== chainSubmissionId)
  ) return json({ error: "Onchain submission does not match the uploaded work" }, 422);
  const fileKey = `private/${contestId}/${submissionId}/v${version}/${file.name}`;
  await env.UPLOADS.put(fileKey,bytes,{httpMetadata:{contentType:file.type},customMetadata:{creator,contestId,contentHash,txHash:verified.txHash}});
  const bond = contest.asset_type === "Photo / Visual" ? 500_000 : contest.asset_type === "Short Video" || contest.asset_type === "Static Page" ? 1_000_000 : 2_000_000;
  const now = new Date().toISOString();
  const submissionWrite = existing
    ? database.prepare(`UPDATE submissions SET version=?,file_key=?,original_name=?,mime_type=?,byte_size=?,chain_submission_id=?,eligibility='CHECKING',submitted_at=? WHERE id=?`).bind(version,fileKey,file.name,file.type,file.size,chainSubmissionId,now,submissionId)
    : database.prepare(`INSERT INTO submissions (id,contest_id,creator,version,file_key,original_name,mime_type,byte_size,bond_micros,chain_submission_id,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(submissionId,contestId,creator,version,fileKey,file.name,file.type,file.size,bond,chainSubmissionId,now);
  await database.batch([
    submissionWrite,
    database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,creator,"SUBMISSION_UPLOADED",JSON.stringify({submissionId,chainSubmissionId,version,contentHash,txHash:verified.txHash}),now),
    chainRecord(database,verified,creator,"WORK_SUBMITTED",contestId,now),
  ]);
  return json({ submissionId, chainSubmissionId, version, contentHash, txHash: verified.txHash, eligibility: "CHECKING", bondMicros: bond, bondRequired: !existing, replacementsRemaining: 3 - version }, 201);
}

async function eligibility(request, env, submissionId) {
  const authError = authorizeEvaluator(request, env);
  if (authError) return authError;
  const body = await request.json().catch(() => ({})), status = body.status === "VALID" ? "VALID" : "NEEDS_FIX";
  const database = await db(env);
  const submission = await database.prepare(`SELECT contest_id,chain_submission_id FROM submissions WHERE id=?`).bind(submissionId).first();
  if (!submission?.chain_submission_id) return json({ error: "Submission not found" }, 404);
  const contest = await database.prepare(`SELECT chain_contest_id FROM contests WHERE id=?`).bind(submission.contest_id).first();
  const reused = await rejectReusedTransaction(database, body.txHash);
  if (reused) return reused;
  const verified = await verifiedChainTransaction(env, { txHash: String(body.txHash || ""), eventName: "EligibilityRecorded" });
  if (verified instanceof Response) return verified;
  const expectedEligibility = status === "VALID" ? 1n : 2n;
  const reasonHash = eligibilityReasonHash(body);
  if (
    asBigInt(verified.args.contestId) !== BigInt(contest.chain_contest_id) ||
    asBigInt(verified.args.submissionId) !== BigInt(submission.chain_submission_id) ||
    asBigInt(verified.args.eligibility) !== expectedEligibility ||
    !sameHex(verified.args.reasonHash, reasonHash)
  ) return json({ error: "Onchain eligibility result does not match the evaluator payload" }, 422);
  const now = new Date().toISOString(), actor = verified.transaction.from.toLowerCase();
  await database.batch([
    database.prepare(`UPDATE submissions SET eligibility=?,reason_codes_json=?,ai_message=? WHERE id=?`).bind(status,JSON.stringify(body.reasonCodes||[]),body.message||null,submissionId),
    chainRecord(database,verified,actor,"ELIGIBILITY_RECORDED",submission.contest_id,now),
  ]);
  return json({ submissionId, eligibility: status, txHash: verified.txHash });
}

async function settle(request, env, contestId) {
  const database = await db(env);
  const requester = await walletForWrite(request, env, database);
  if (requester instanceof Response) return requester;
  const body = await request.json().catch(() => ({}));
  const contest = await database.prepare(`SELECT requester,status,chain_contest_id FROM contests WHERE id=?`).bind(contestId).first();
  if (!contest || contest.requester !== requester) return json({ error: "Only requester can select the winner" }, 403);
  const winner = await database.prepare(`SELECT id,chain_submission_id FROM submissions WHERE id=? AND contest_id=? AND eligibility='VALID'`).bind(body.submissionId,contestId).first();
  if (!winner?.chain_submission_id) return json({ error: "Winner must be valid" }, 422);
  const reused = await rejectReusedTransaction(database, body.txHash);
  if (reused) return reused;
  const verified = await verifiedChainTransaction(env, { txHash: String(body.txHash || ""), actor: requester, eventName: "ContestSettled" });
  if (verified instanceof Response) return verified;
  if (asBigInt(verified.args.contestId) !== BigInt(contest.chain_contest_id) || asBigInt(verified.args.winnerSubmissionId) !== BigInt(winner.chain_submission_id)) return json({ error: "Onchain winner does not match the selected submission" }, 422);
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`UPDATE contests SET status='SETTLED',winner_submission_id=?,tx_hash=? WHERE id=?`).bind(body.submissionId,verified.txHash,contestId),
    chainRecord(database,verified,requester,"CONTEST_SETTLED",contestId,now),
  ]);
  return json({ status: "SETTLED", winnerSubmissionId: body.submissionId, txHash: verified.txHash });
}

async function cancelContest(request, env, contestId) {
  const database = await db(env);
  const requester = await walletForWrite(request, env, database);
  if (requester instanceof Response) return requester;
  const body = await request.json().catch(() => ({}));
  const contest = await database.prepare(`SELECT requester,status,budget_micros,chain_contest_id FROM contests WHERE id=?`).bind(contestId).first();
  if (!contest) return json({ error: "Contest not found" }, 404);
  if (contest.requester !== requester) return json({ error: "Only requester can cancel the contest" }, 403);
  const count = await database.prepare(`SELECT COUNT(*) AS total FROM submissions WHERE contest_id=?`).bind(contestId).first();
  if (contest.status !== "OPEN" || Number(count?.total || 0) !== 0) return json({ error: "Cancellation is only available before the first submission" }, 409);
  const reused = await rejectReusedTransaction(database, body.txHash);
  if (reused) return reused;
  const verified = await verifiedChainTransaction(env, { txHash: String(body.txHash || ""), actor: requester, eventName: "ContestCancelled" });
  if (verified instanceof Response) return verified;
  if (asBigInt(verified.args.contestId) !== BigInt(contest.chain_contest_id) || asBigInt(verified.args.refund) < BigInt(contest.budget_micros)) return json({ error: "Onchain cancellation does not match the contest" }, 422);
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`UPDATE contests SET status='CANCELLED',tx_hash=? WHERE id=? AND status='OPEN'`).bind(verified.txHash,contestId),
    database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,requester,"CONTEST_CANCELLED",JSON.stringify({refundMicros:String(verified.args.refund),txHash:verified.txHash}),now),
    chainRecord(database,verified,requester,"CONTEST_CANCELLED",contestId,now),
  ]);
  return json({ contestId, status: "CANCELLED", refundMicros: Number(verified.args.refund), txHash: verified.txHash });
}

async function addSlotPack(request, env, contestId) {
  const database = await db(env);
  const requester = await walletForWrite(request, env, database);
  if (requester instanceof Response) return requester;
  const body = await request.json().catch(() => ({}));
  const contest = await database.prepare(`SELECT requester,status,asset_type,valid_cap,budget_micros,chain_contest_id FROM contests WHERE id=?`).bind(contestId).first();
  if (!contest) return json({ error: "Contest not found" }, 404);
  if (contest.requester !== requester) return json({ error: "Only requester can add slots" }, 403);
  const baseCap = contest.asset_type === "Photo / Visual" ? 10 : 5;
  const packs = Math.max(0, Math.floor((contest.valid_cap - baseCap) / 5));
  if (contest.status !== "OPEN" || packs >= 3) return json({ error: "Slot pack limit reached or contest is closed" }, 409);
  const feeMicros = Math.floor(contest.budget_micros / 10), participationMicros = Math.floor(feeMicros / 2), validCap = contest.valid_cap + 5;
  const reused = await rejectReusedTransaction(database, body.txHash);
  if (reused) return reused;
  const verified = await verifiedChainTransaction(env, { txHash: String(body.txHash || ""), actor: requester, eventName: "SlotsAdded" });
  if (verified instanceof Response) return verified;
  if (asBigInt(verified.args.contestId) !== BigInt(contest.chain_contest_id) || Number(verified.args.newValidCap) !== validCap || asBigInt(verified.args.fee) !== BigInt(feeMicros)) return json({ error: "Onchain slot purchase does not match the contest" }, 422);
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`UPDATE contests SET valid_cap=?,tx_hash=? WHERE id=? AND status='OPEN'`).bind(validCap,verified.txHash,contestId),
    database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,requester,"SLOTS_ADDED",JSON.stringify({validCap,feeMicros,participationMicros,platformMicros:feeMicros-participationMicros,txHash:verified.txHash}),now),
    chainRecord(database,verified,requester,"SLOTS_ADDED",contestId,now),
  ]);
  return json({ contestId, validCap, slotPacks: packs + 1, feeMicros, participationMicros, platformMicros: feeMicros - participationMicros, txHash: verified.txHash });
}

async function settleAfterTimeout(request, env, contestId) {
  const database = await db(env);
  const settler = await walletForWrite(request, env, database);
  if (settler instanceof Response) return settler;
  const body = await request.json().catch(() => ({}));
  const contest = await database.prepare(`SELECT status,budget_micros,submission_deadline,chain_contest_id FROM contests WHERE id=?`).bind(contestId).first();
  if (!contest) return json({ error: "Contest not found" }, 404);
  const deadline = Date.parse(contest.submission_deadline), judgingEndsAt = deadline + 48 * 60 * 60 * 1000;
  if (contest.status !== "OPEN" || !Number.isFinite(deadline) || Date.now() < judgingEndsAt) return json({ error: "The 48-hour judging window has not expired" }, 409);
  const valid = await database.prepare(`SELECT COUNT(*) AS total FROM submissions WHERE contest_id=? AND eligibility='VALID'`).bind(contestId).first();
  const slotEvents = await database.prepare(`SELECT payload_json FROM events WHERE contest_id=? AND event_type='SLOTS_ADDED'`).bind(contestId).all();
  const slotFeesMicros = slotEvents.results.reduce((total,event) => { try { return total + Number(JSON.parse(event.payload_json).feeMicros || 0); } catch { return total; } },0);
  const validCount = Number(valid?.total || 0), creatorBaseMicros = Math.floor(contest.budget_micros * 90 / 100), creatorPoolMicros = creatorBaseMicros + Math.floor(slotFeesMicros / 2);
  let platformMicros = contest.budget_micros - creatorBaseMicros + slotFeesMicros - Math.floor(slotFeesMicros / 2);
  const eachCreatorMicros = validCount > 0 ? Math.floor(creatorPoolMicros / validCount) : 0, requesterRefundMicros = validCount === 0 ? creatorPoolMicros : 0;
  if (validCount > 0) platformMicros += creatorPoolMicros - eachCreatorMicros * validCount;
  const reused = await rejectReusedTransaction(database, body.txHash);
  if (reused) return reused;
  const verified = await verifiedChainTransaction(env, { txHash: String(body.txHash || ""), actor: settler, eventName: "TimeoutSettlement" });
  if (verified instanceof Response) return verified;
  if (
    asBigInt(verified.args.contestId) !== BigInt(contest.chain_contest_id) ||
    Number(verified.args.validCount) !== validCount ||
    asBigInt(verified.args.creatorPool) !== BigInt(creatorPoolMicros) ||
    asBigInt(verified.args.requesterRefund) !== BigInt(requesterRefundMicros) ||
    asBigInt(verified.args.platformAmount) !== BigInt(platformMicros)
  ) return json({ error: "Onchain timeout allocation does not match the contest" }, 422);
  const status = validCount > 0 ? "TIMEOUT_SETTLED" : "REFUNDED_NO_VALID", now = new Date().toISOString();
  const allocation = { validCount, eachCreatorMicros, requesterRefundMicros, platformMicros, slotFeesMicros, txHash: verified.txHash };
  await database.batch([
    database.prepare(`UPDATE contests SET status=?,tx_hash=? WHERE id=? AND status='OPEN'`).bind(status,verified.txHash,contestId),
    database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,settler,"TIMEOUT_SETTLED",JSON.stringify(allocation),now),
    chainRecord(database,verified,settler,"TIMEOUT_SETTLED",contestId,now),
  ]);
  return json({ contestId, status, ...allocation, winnerSubmissionId: null, rightsTransferred: false });
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return json({
    ok: true,
    chainId: 10143,
    token: "AUSD",
    walletWrites: env.KOTAE_AUTH_MODE === "demo" ? "demo-only" : "signature",
    chainVerificationConfigured: Boolean(env.MONAD_RPC_URL && env.KOTAE_ESCROW_ADDRESS),
    evaluatorConfigured: typeof env.KOTAE_EVALUATOR_SECRET === "string" && env.KOTAE_EVALUATOR_SECRET.length >= 32,
  });
  if (url.pathname === "/api/auth/challenge" && request.method === "POST") return createWalletChallenge(request,await db(env));
  if (url.pathname === "/api/auth/verify" && request.method === "POST") return verifyWalletChallenge(request,await db(env));
  if (url.pathname === "/api/auth/session" && request.method === "GET") return walletSession(request,env,await db(env));
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return logoutWallet(request,await db(env));
  if (url.pathname === "/api/contests" && request.method === "GET") return listContests(env);
  if (url.pathname === "/api/contests" && request.method === "POST") return createContest(request,env);
  let match = url.pathname.match(/^\/api\/contests\/([^/]+)\/submissions$/);
  if (match && request.method === "POST") return submitWork(request,env,match[1]);
  match = url.pathname.match(/^\/api\/submissions\/([^/]+)\/eligibility$/);
  if (match && request.method === "PATCH") return eligibility(request,env,match[1]);
  match = url.pathname.match(/^\/api\/contests\/([^/]+)\/settle$/);
  if (match && request.method === "POST") return settle(request,env,match[1]);
  match = url.pathname.match(/^\/api\/contests\/([^/]+)\/cancel$/);
  if (match && request.method === "POST") return cancelContest(request,env,match[1]);
  match = url.pathname.match(/^\/api\/contests\/([^/]+)\/slots$/);
  if (match && request.method === "POST") return addSlotPack(request,env,match[1]);
  match = url.pathname.match(/^\/api\/contests\/([^/]+)\/timeout-settle$/);
  if (match && request.method === "POST") return settleAfterTimeout(request,env,match[1]);
  return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found",{status:404});
}};
