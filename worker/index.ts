import { getDb, type D1Like } from "../db/index";

interface R2Like {
  put(key: string, value: ReadableStream | ArrayBuffer, options?: Record<string, unknown>): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
}

interface Env {
  DB: D1Like;
  UPLOADS: R2Like;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

const headers = { "content-type": "application/json; charset=utf-8" };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const wallet = (request: Request) => request.headers.get("x-wallet-address") || "demo:anonymous";

async function listContests(env: Env) {
  const db = await getDb(env.DB);
  const rows = await db.prepare(`SELECT c.*, COUNT(CASE WHEN s.eligibility = 'VALID' THEN 1 END) AS valid_count,
    COUNT(s.id) AS submission_count FROM contests c LEFT JOIN submissions s ON s.contest_id = c.id
    GROUP BY c.id ORDER BY c.created_at DESC`).all<Record<string, unknown>>();
  return response({ contests: rows.results });
}

async function createContest(request: Request, env: Env) {
  const body = await request.json<Record<string, unknown>>();
  const contestId = id("contest");
  const now = new Date().toISOString();
  const budget = Math.round(Number(body.budget) * 1_000_000);
  const minimums: Record<string, number> = { "Photo / Visual": 2, "Short Video": 8, "Static Page": 10, "Micro Tool": 20 };
  const type = String(body.type);
  if (!minimums[type] || budget < minimums[type] * 1_000_000) return response({ error: "Budget below asset minimum" }, 422);
  const db = await getDb(env.DB);
  const txHash = request.headers.get("x-funding-tx");
  await db.batch([
    db.prepare(`INSERT INTO contests (id,requester,title,asset_type,brief,must_json,avoid_json,budget_micros,valid_cap,submission_deadline,status,tx_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(contestId,wallet(request),String(body.title),type,String(body.brief),JSON.stringify(body.must||[]),JSON.stringify(body.avoid||[]),budget,Number(body.cap),String(body.deadlineAt || body.deadline),"OPEN",txHash,now),
    db.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,wallet(request),"CONTEST_FUNDED",JSON.stringify({budget,txHash}),now),
  ]);
  return response({ contest: { ...body, id: contestId, requester: wallet(request), validCount: 0, submissions: 0, status: "OPEN" }, txHash }, 201);
}

async function submitWork(request: Request, env: Env, contestId: string) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return response({ error: "Original file is required" }, 422);
  const db = await getDb(env.DB);
  const contest = await db.prepare(`SELECT asset_type,valid_cap,status FROM contests WHERE id=?`).bind(contestId).first<{asset_type:string;valid_cap:number;status:string}>();
  if (!contest || contest.status !== "OPEN") return response({ error: "Contest is not open" }, 409);
  const limits: Record<string, number> = { "Photo / Visual": 20_000_000, "Short Video": 50_000_000, "Static Page": 10_000_000, "Micro Tool": 10_000_000 };
  if (file.size > limits[contest.asset_type]) return response({ error: "File exceeds type limit" }, 413);
  if (file.size < 1024) return response({ error: "File is empty or too small" }, 422);
  const imageAllowed = ["image/png","image/jpeg","image/webp"].includes(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
  const videoAllowed = ["video/mp4","video/webm"].includes(file.type) || /\.(mp4|webm)$/i.test(file.name);
  const zipAllowed = ["application/zip","application/x-zip-compressed"].includes(file.type) || /\.zip$/i.test(file.name);
  if (contest.asset_type === "Photo / Visual" ? !imageAllowed : contest.asset_type === "Short Video" ? !videoAllowed : !zipAllowed) return response({ error: "Unsupported file format" }, 415);
  const creator = wallet(request);
  const existing = await db.prepare(`SELECT id,version FROM submissions WHERE contest_id=? AND creator=?`).bind(contestId,creator).first<{id:string;version:number}>();
  if (existing && existing.version >= 3) return response({ error: "Replacement limit reached" }, 409);
  const submissionId = existing?.id || id("submission");
  const version = (existing?.version || 0) + 1;
  const fileKey = `private/${contestId}/${submissionId}/v${version}/${file.name}`;
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const contentHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,"0")).join("");
  await env.UPLOADS.put(fileKey, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { creator, contestId, contentHash } });
  const bonds: Record<string, number> = { "Photo / Visual": 500_000, "Short Video": 1_000_000, "Static Page": 1_000_000, "Micro Tool": 2_000_000 };
  const now = new Date().toISOString();
  if (existing) {
    await db.prepare(`UPDATE submissions SET version=?,file_key=?,original_name=?,mime_type=?,byte_size=?,eligibility='CHECKING',submitted_at=? WHERE id=?`).bind(version,fileKey,file.name,file.type,file.size,now,submissionId).run();
  } else {
    await db.prepare(`INSERT INTO submissions (id,contest_id,creator,version,file_key,original_name,mime_type,byte_size,bond_micros,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(submissionId,contestId,creator,version,fileKey,file.name,file.type,file.size,bonds[contest.asset_type],now).run();
  }
  await db.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,creator,"SUBMISSION_UPLOADED",JSON.stringify({submissionId,version,contentHash}),now).run();
  return response({ submissionId, version, contentHash, eligibility: "CHECKING", bondMicros: bonds[contest.asset_type], bondRequired: !existing, replacementsRemaining: 3 - version }, 201);
}

async function recordEligibility(request: Request, env: Env, submissionId: string) {
  if (request.headers.get("x-kotae-worker-secret") !== "configured") return response({ error: "Unauthorized evaluator" }, 401);
  const body = await request.json<{status:string;reasonCodes?:string[];message?:string}>();
  const status = body.status === "VALID" ? "VALID" : "NEEDS_FIX";
  const db = await getDb(env.DB);
  await db.prepare(`UPDATE submissions SET eligibility=?,reason_codes_json=?,ai_message=? WHERE id=?`).bind(status,JSON.stringify(body.reasonCodes||[]),body.message||null,submissionId).run();
  return response({ submissionId, eligibility: status });
}

async function settle(request: Request, env: Env, contestId: string) {
  const body = await request.json<{submissionId:string;txHash:string}>();
  const db = await getDb(env.DB);
  const contest = await db.prepare(`SELECT requester,status FROM contests WHERE id=?`).bind(contestId).first<{requester:string;status:string}>();
  if (!contest || contest.requester !== wallet(request)) return response({ error: "Only requester can select the winner" }, 403);
  const winning = await db.prepare(`SELECT id FROM submissions WHERE id=? AND contest_id=? AND eligibility='VALID'`).bind(body.submissionId,contestId).first();
  if (!winning) return response({ error: "Winner must be a valid submission" }, 422);
  await db.prepare(`UPDATE contests SET status='SETTLED',winner_submission_id=?,tx_hash=? WHERE id=?`).bind(body.submissionId,body.txHash,contestId).run();
  return response({ status: "SETTLED", winnerSubmissionId: body.submissionId, txHash: body.txHash });
}

async function cancelContest(request: Request, env: Env, contestId: string) {
  const db = await getDb(env.DB);
  const contest = await db.prepare(`SELECT requester,status,budget_micros FROM contests WHERE id=?`).bind(contestId).first<{requester:string;status:string;budget_micros:number}>();
  if (!contest) return response({ error: "Contest not found" }, 404);
  if (contest.requester !== wallet(request)) return response({ error: "Only requester can cancel the contest" }, 403);
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM submissions WHERE contest_id=?`).bind(contestId).first<{total:number}>();
  if (contest.status !== "OPEN" || Number(count?.total || 0) !== 0) return response({ error: "Cancellation is only available before the first submission" }, 409);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE contests SET status='CANCELLED' WHERE id=? AND status='OPEN'`).bind(contestId),
    db.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,wallet(request),"CONTEST_CANCELLED",JSON.stringify({refundMicros:contest.budget_micros}),now),
  ]);
  return response({ contestId, status: "CANCELLED", refundMicros: contest.budget_micros });
}

async function addSlotPack(request: Request, env: Env, contestId: string) {
  const db = await getDb(env.DB);
  const contest = await db.prepare(`SELECT requester,status,asset_type,valid_cap,budget_micros FROM contests WHERE id=?`).bind(contestId).first<{requester:string;status:string;asset_type:string;valid_cap:number;budget_micros:number}>();
  if (!contest) return response({ error: "Contest not found" }, 404);
  if (contest.requester !== wallet(request)) return response({ error: "Only requester can add slots" }, 403);
  const baseCap = contest.asset_type === "Photo / Visual" ? 10 : 5;
  const packs = Math.max(0, Math.floor((contest.valid_cap - baseCap) / 5));
  if (contest.status !== "OPEN" || packs >= 3) return response({ error: "Slot pack limit reached or contest is closed" }, 409);
  const feeMicros = Math.floor(contest.budget_micros / 10);
  const participationMicros = Math.floor(feeMicros / 2);
  const validCap = contest.valid_cap + 5;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE contests SET valid_cap=? WHERE id=? AND status='OPEN'`).bind(validCap,contestId),
    db.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,wallet(request),"SLOTS_ADDED",JSON.stringify({validCap,feeMicros,participationMicros,platformMicros:feeMicros-participationMicros}),now),
  ]);
  return response({ contestId, validCap, slotPacks: packs + 1, feeMicros, participationMicros, platformMicros: feeMicros - participationMicros });
}

async function settleAfterTimeout(request: Request, env: Env, contestId: string) {
  const body = await request.json<{txHash?:string}>().catch(() => ({}));
  const db = await getDb(env.DB);
  const contest = await db.prepare(`SELECT status,budget_micros,submission_deadline FROM contests WHERE id=?`).bind(contestId).first<{status:string;budget_micros:number;submission_deadline:string}>();
  if (!contest) return response({ error: "Contest not found" }, 404);
  const deadline = Date.parse(contest.submission_deadline);
  const judgingEndsAt = deadline + 48 * 60 * 60 * 1000;
  if (contest.status !== "OPEN" || !Number.isFinite(deadline) || Date.now() < judgingEndsAt) return response({ error: "The 48-hour judging window has not expired" }, 409);
  const valid = await db.prepare(`SELECT COUNT(*) AS total FROM submissions WHERE contest_id=? AND eligibility='VALID'`).bind(contestId).first<{total:number}>();
  const slotEvents = await db.prepare(`SELECT payload_json FROM events WHERE contest_id=? AND event_type='SLOTS_ADDED'`).bind(contestId).all<{payload_json:string}>();
  const slotFeesMicros = slotEvents.results.reduce((total, event) => {
    try { return total + Number((JSON.parse(event.payload_json) as {feeMicros?:number}).feeMicros || 0); }
    catch { return total; }
  }, 0);
  const validCount = Number(valid?.total || 0);
  const creatorBaseMicros = Math.floor(contest.budget_micros * 90 / 100);
  const creatorPoolMicros = creatorBaseMicros + Math.floor(slotFeesMicros / 2);
  let platformMicros = contest.budget_micros - creatorBaseMicros + slotFeesMicros - Math.floor(slotFeesMicros / 2);
  const eachCreatorMicros = validCount > 0 ? Math.floor(creatorPoolMicros / validCount) : 0;
  const requesterRefundMicros = validCount === 0 ? creatorPoolMicros : 0;
  if (validCount > 0) platformMicros += creatorPoolMicros - eachCreatorMicros * validCount;
  const status = validCount > 0 ? "TIMEOUT_SETTLED" : "REFUNDED_NO_VALID";
  const now = new Date().toISOString();
  const allocation = { validCount, eachCreatorMicros, requesterRefundMicros, platformMicros, slotFeesMicros, txHash: body.txHash || null };
  await db.batch([
    db.prepare(`UPDATE contests SET status=?,tx_hash=? WHERE id=? AND status='OPEN'`).bind(status,body.txHash || null,contestId),
    db.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,wallet(request),"TIMEOUT_SETTLED",JSON.stringify(allocation),now),
  ]);
  return response({ contestId, status, ...allocation, winnerSubmissionId: null, rightsTransferred: false });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return response({ ok: true, chainId: 10143, token: "AUSD" });
    if (url.pathname === "/api/contests" && request.method === "GET") return listContests(env);
    if (url.pathname === "/api/contests" && request.method === "POST") return createContest(request,env);
    const submissionMatch = url.pathname.match(/^\/api\/contests\/([^/]+)\/submissions$/);
    if (submissionMatch && request.method === "POST") return submitWork(request,env,submissionMatch[1]);
    const eligibilityMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/eligibility$/);
    if (eligibilityMatch && request.method === "PATCH") return recordEligibility(request,env,eligibilityMatch[1]);
    const settleMatch = url.pathname.match(/^\/api\/contests\/([^/]+)\/settle$/);
    if (settleMatch && request.method === "POST") return settle(request,env,settleMatch[1]);
    const cancelMatch = url.pathname.match(/^\/api\/contests\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === "POST") return cancelContest(request,env,cancelMatch[1]);
    const slotsMatch = url.pathname.match(/^\/api\/contests\/([^/]+)\/slots$/);
    if (slotsMatch && request.method === "POST") return addSlotPack(request,env,slotsMatch[1]);
    const timeoutMatch = url.pathname.match(/^\/api\/contests\/([^/]+)\/timeout-settle$/);
    if (timeoutMatch && request.method === "POST") return settleAfterTimeout(request,env,timeoutMatch[1]);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }
};
