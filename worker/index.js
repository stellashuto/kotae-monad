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
  verifyEscrowTransaction,
} from "./chain.js";
import { recordObjectiveEligibility } from "./oracle.js";

const embeddedStaticAssets = globalThis.__KOTAE_STATIC_ASSETS__;
const CURRENT_SITE_VERSION = "18";
const initializedBindings = new WeakSet();
async function db(env) {
  if (!env.DB) throw new Error("D1 binding DB is required");
  if (!initializedBindings.has(env.DB)) {
    await env.DB.batch(schemaStatements.map((sql) => env.DB.prepare(sql)));
    try { await env.DB.prepare(`ALTER TABLE contests ADD COLUMN escrow_address TEXT`).run(); } catch { /* Existing or fresh schema already has the column. */ }
    const currentEscrow = String(env.KOTAE_ESCROW_ADDRESS || "").toLowerCase();
    const legacyEscrow = String(env.LEGACY_KOTAE_ESCROW_ADDRESS || "").toLowerCase();
    if (legacyEscrow && currentEscrow && legacyEscrow !== currentEscrow) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE contests SET escrow_address=? WHERE escrow_address IS NULL`).bind(legacyEscrow),
        env.DB.prepare(`UPDATE submissions SET chain_submission_id='legacy:' || chain_submission_id WHERE contest_id IN (SELECT id FROM contests WHERE lower(escrow_address)=?) AND chain_submission_id IS NOT NULL AND chain_submission_id NOT LIKE 'legacy:%'`).bind(legacyEscrow),
        env.DB.prepare(`UPDATE contests SET chain_contest_id='legacy:' || chain_contest_id WHERE lower(escrow_address)=? AND chain_contest_id IS NOT NULL AND chain_contest_id NOT LIKE 'legacy:%'`).bind(legacyEscrow),
      ]);
    }
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

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function rangedEmbeddedResponse(request, bytes, asset) {
  const total = bytes.byteLength;
  const headers = {
    "content-type": asset.contentType,
    "cache-control": "no-cache",
    "accept-ranges": "bytes",
  };
  const range = request.headers.get("range");
  if (!range) {
    headers["content-length"] = String(total);
    return new Response(request.method === "HEAD" ? null : bytes, { headers });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    headers["content-range"] = `bytes */${total}`;
    return new Response(null, { status: 416, headers });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : total - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= total || end < start) {
    headers["content-range"] = `bytes */${total}`;
    return new Response(null, { status: 416, headers });
  }

  end = Math.min(end, total - 1);
  const slice = bytes.slice(start, end + 1);
  headers["content-length"] = String(slice.byteLength);
  headers["content-range"] = `bytes ${start}-${end}/${total}`;
  return new Response(request.method === "HEAD" ? null : slice, { status: 206, headers });
}

function embeddedStaticResponse(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if ((url.pathname === "/" || url.pathname === "/index.html") && url.searchParams.has("v") && url.searchParams.get("v") !== CURRENT_SITE_VERSION) {
    url.searchParams.set("v", CURRENT_SITE_VERSION);
    return Response.redirect(url.toString(), 302);
  }
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const asset = embeddedStaticAssets?.[pathname];
  if (!asset) return null;
  if (asset.range && asset.encoding === "base64") return rangedEmbeddedResponse(request, decodeBase64(asset.body), asset);
  const body = request.method === "HEAD" ? null : asset.encoding === "base64" ? decodeBase64(asset.body) : asset.body;
  return new Response(body, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "no-cache",
    },
  });
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
  const currentEscrow = String(env.KOTAE_ESCROW_ADDRESS || "").toLowerCase();
  const rows = await database.prepare(`SELECT c.*, COUNT(CASE WHEN s.eligibility='VALID' THEN 1 END) valid_count, COUNT(s.id) submission_count FROM contests c LEFT JOIN submissions s ON s.contest_id=c.id WHERE lower(c.escrow_address)=? GROUP BY c.id ORDER BY c.created_at DESC`).bind(currentEscrow).all();
  const contests = rows.results.map((row) => ({
    id: row.id,
    chainContestId: row.chain_contest_id,
    requester: row.requester,
    title: row.title,
    type: row.asset_type,
    brief: row.brief,
    must: JSON.parse(row.must_json || "[]"),
    avoid: JSON.parse(row.avoid_json || "[]"),
    budget: Number(row.budget_micros) / 1_000_000,
    cap: Number(row.valid_cap),
    validCount: Number(row.valid_count),
    submissions: Number(row.submission_count),
    deadline: row.submission_deadline,
    txHash: row.tx_hash,
    createdAt: row.created_at,
    status: row.status === "OPEN" && Date.now() > Date.parse(row.submission_deadline) + 48 * 60 * 60 * 1000 ? "JUDGING_EXPIRED" : row.status,
  }));
  return json({ contests });
}

async function listContestSubmissions(env, contestId) {
  const database = await db(env);
  const rows = await database.prepare(`SELECT id,creator,version,eligibility,chain_submission_id,submitted_at FROM submissions WHERE contest_id=? ORDER BY submitted_at`).bind(contestId).all();
  return json({ submissions: rows.results.map((row) => ({
    id: row.id,
    creator: row.creator,
    version: Number(row.version),
    eligibility: row.eligibility,
    chainSubmissionId: row.chain_submission_id,
    submittedAt: row.submitted_at,
  })) });
}

async function privateSubmissionFile(request, env, submissionId) {
  const database = await db(env);
  const viewer = await authenticatedWallet(request, env, database, { requireOrigin: false });
  if (viewer instanceof Response) return viewer;
  const submission = await database.prepare(`SELECT s.file_key,s.original_name,s.mime_type,s.creator,c.requester FROM submissions s JOIN contests c ON c.id=s.contest_id WHERE s.id=?`).bind(submissionId).first();
  if (!submission) return json({ error: "Submission not found" }, 404);
  if (viewer !== submission.creator.toLowerCase() && viewer !== submission.requester.toLowerCase()) return json({ error: "Private submission access denied" }, 403);
  const object = await env.UPLOADS.get(submission.file_key);
  if (!object) return json({ error: "Submission file not found" }, 404);
  const headers = new Headers({
    "content-type": submission.mime_type,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(submission.original_name)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  return new Response(object.body, { headers });
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
    database.prepare(`INSERT INTO contests (id,requester,title,asset_type,brief,must_json,avoid_json,budget_micros,valid_cap,submission_deadline,status,tx_hash,chain_contest_id,escrow_address,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,requester,body.title,body.type,body.brief,JSON.stringify(body.must||[]),JSON.stringify(body.avoid||[]),budget,body.cap,deadlineAt,"OPEN",verified.txHash,chainContestId,String(env.KOTAE_ESCROW_ADDRESS || "").toLowerCase(),now),
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
  let objectiveEligibility = "CHECKING", oracleTxHash = null;
  try {
    const oracle = await recordObjectiveEligibility(env, chainSubmissionId);
    await database.batch([
      database.prepare(`UPDATE submissions SET eligibility='VALID',reason_codes_json=?,ai_message=? WHERE id=?`).bind(JSON.stringify(oracle.reasonCodes),oracle.message,submissionId),
      database.prepare(`INSERT INTO chain_transactions (tx_hash,actor,action,contest_id,block_number,verified_at) VALUES (?,?,?,?,?,?)`).bind(oracle.txHash,oracle.actor,"ELIGIBILITY_RECORDED",contestId,oracle.blockNumber,new Date().toISOString()),
      database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,oracle.actor,"OBJECTIVE_ELIGIBILITY_RECORDED",JSON.stringify({submissionId,chainSubmissionId,txHash:oracle.txHash}),new Date().toISOString()),
    ]);
    objectiveEligibility = "VALID";
    oracleTxHash = oracle.txHash;
  } catch (error) {
    console.error("Independent Oracle finalization failed", error instanceof Error ? error.message : String(error));
  }
  return json({ submissionId, chainSubmissionId, version, contentHash, txHash: verified.txHash, oracleTxHash, eligibility: objectiveEligibility, bondMicros: bond, bondRequired: !existing, replacementsRemaining: 3 - version }, 201);
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
    escrowAddress: env.KOTAE_ESCROW_ADDRESS || null,
    ausdAddress: env.AUSD_ADDRESS || null,
    ausdFaucetAddress: env.AUSD_FAUCET_ADDRESS || "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
    eligibilityOracle: env.ELIGIBILITY_ORACLE || env.KOTAE_ELIGIBILITY_ORACLE || null,
    eligibilityOracleConfigured: /^0x[0-9a-fA-F]{40}$/.test(String(env.ELIGIBILITY_ORACLE || "")) && /^0x[0-9a-fA-F]{64}$/.test(String(env.ELIGIBILITY_ORACLE_PRIVATE_KEY || "")),
    requesterOracleSeparated: Boolean(env.PLATFORM_RECIPIENT && env.ELIGIBILITY_ORACLE && String(env.PLATFORM_RECIPIENT).toLowerCase() !== String(env.ELIGIBILITY_ORACLE).toLowerCase()),
  });
  if (url.pathname === "/api/auth/challenge" && request.method === "POST") return createWalletChallenge(request,await db(env),env);
  if (url.pathname === "/api/auth/verify" && request.method === "POST") return verifyWalletChallenge(request,await db(env),env);
  if (url.pathname === "/api/auth/session" && request.method === "GET") return walletSession(request,env,await db(env));
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return logoutWallet(request,await db(env),env);
  if (url.pathname === "/api/contests" && request.method === "GET") return listContests(env);
  if (url.pathname === "/api/contests" && request.method === "POST") return createContest(request,env);
  let match = url.pathname.match(/^\/api\/contests\/([^/]+)\/submissions$/);
  if (match && request.method === "GET") return listContestSubmissions(env,match[1]);
  if (match && request.method === "POST") return submitWork(request,env,match[1]);
  match = url.pathname.match(/^\/api\/submissions\/([^/]+)\/file$/);
  if (match && request.method === "GET") return privateSubmissionFile(request,env,match[1]);
  match = url.pathname.match(/^\/api\/contests\/([^/]+)\/settle$/);
  if (match && request.method === "POST") return settle(request,env,match[1]);
  match = url.pathname.match(/^\/api\/contests\/([^/]+)\/cancel$/);
  if (match && request.method === "POST") return cancelContest(request,env,match[1]);
  match = url.pathname.match(/^\/api\/contests\/([^/]+)\/slots$/);
  if (match && request.method === "POST") return addSlotPack(request,env,match[1]);
  match = url.pathname.match(/^\/api\/contests\/([^/]+)\/timeout-settle$/);
  if (match && request.method === "POST") return settleAfterTimeout(request,env,match[1]);
  const embedded = embeddedStaticResponse(request);
  if (embedded) return embedded;
  return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found",{status:404});
}};
