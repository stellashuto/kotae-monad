const schema = [
  `CREATE TABLE IF NOT EXISTS contests (id TEXT PRIMARY KEY, requester TEXT NOT NULL, title TEXT NOT NULL, asset_type TEXT NOT NULL, brief TEXT NOT NULL, must_json TEXT NOT NULL DEFAULT '[]', avoid_json TEXT NOT NULL DEFAULT '[]', budget_micros INTEGER NOT NULL, valid_cap INTEGER NOT NULL, submission_deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', tx_hash TEXT, winner_submission_id TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, contest_id TEXT NOT NULL REFERENCES contests(id), creator TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, file_key TEXT NOT NULL, preview_key TEXT, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, bond_micros INTEGER NOT NULL, eligibility TEXT NOT NULL DEFAULT 'CHECKING', reason_codes_json TEXT NOT NULL DEFAULT '[]', ai_message TEXT, submitted_at TEXT NOT NULL, UNIQUE(contest_id, creator))`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, contest_id TEXT NOT NULL, actor TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS contests_status_deadline_idx ON contests(status, submission_deadline)`,
  `CREATE INDEX IF NOT EXISTS submissions_contest_eligibility_idx ON submissions(contest_id, eligibility)`,
];

let initialized = false;
async function db(env) {
  if (!initialized) { await env.DB.batch(schema.map(sql => env.DB.prepare(sql))); initialized = true; }
  return env.DB;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const actor = request => request.headers.get("x-wallet-address") || "demo:anonymous";
const makeId = prefix => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

async function listContests(env) {
  const database = await db(env);
  const rows = await database.prepare(`SELECT c.*, COUNT(CASE WHEN s.eligibility='VALID' THEN 1 END) valid_count, COUNT(s.id) submission_count FROM contests c LEFT JOIN submissions s ON s.contest_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`).all();
  return json({ contests: rows.results });
}

async function createContest(request, env) {
  const body = await request.json();
  const minimums = { "Photo / Visual": 2, "Short Video": 8, "Static Page": 10, "Micro Tool": 20 };
  const budget = Math.round(Number(body.budget) * 1_000_000);
  if (!minimums[body.type] || budget < minimums[body.type] * 1_000_000) return json({ error: "Budget below asset minimum" }, 422);
  const database = await db(env), id = makeId("contest"), now = new Date().toISOString();
  await database.batch([
    database.prepare(`INSERT INTO contests (id,requester,title,asset_type,brief,must_json,avoid_json,budget_micros,valid_cap,submission_deadline,status,tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,actor(request),body.title,body.type,body.brief,JSON.stringify(body.must||[]),JSON.stringify(body.avoid||[]),budget,body.cap,body.deadlineAt||body.deadline,"OPEN",request.headers.get("x-funding-tx"),now),
    database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(id,actor(request),"CONTEST_FUNDED",JSON.stringify({budget}),now),
  ]);
  return json({ contest: { ...body, id, requester: actor(request), validCount: 0, submissions: 0, status: "OPEN" } }, 201);
}

async function submitWork(request, env, contestId) {
  const form = await request.formData(), file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Original file is required" }, 422);
  const database = await db(env);
  const contest = await database.prepare(`SELECT asset_type,valid_cap,status FROM contests WHERE id=?`).bind(contestId).first();
  if (!contest || contest.status !== "OPEN") return json({ error: "Contest is not open" }, 409);
  const limit = contest.asset_type === "Short Video" ? 50_000_000 : contest.asset_type === "Photo / Visual" ? 20_000_000 : 10_000_000;
  if (file.size > limit) return json({ error: "File exceeds type limit" }, 413);
  if (file.size < 1024) return json({ error: "File is empty or too small" }, 422);
  const imageAllowed = ["image/png","image/jpeg","image/webp"].includes(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
  const videoAllowed = ["video/mp4","video/webm"].includes(file.type) || /\.(mp4|webm)$/i.test(file.name);
  const zipAllowed = ["application/zip","application/x-zip-compressed"].includes(file.type) || /\.zip$/i.test(file.name);
  if (contest.asset_type === "Photo / Visual" ? !imageAllowed : contest.asset_type === "Short Video" ? !videoAllowed : !zipAllowed) return json({ error: "Unsupported file format" }, 415);
  const creator = actor(request);
  const existing = await database.prepare(`SELECT id,version FROM submissions WHERE contest_id=? AND creator=?`).bind(contestId,creator).first();
  if (existing?.version >= 3) return json({ error: "Replacement limit reached" }, 409);
  const submissionId = existing?.id || makeId("submission"), version = (existing?.version || 0) + 1;
  const fileKey = `private/${contestId}/${submissionId}/v${version}/${file.name}`;
  const bytes = await file.arrayBuffer(), digest = await crypto.subtle.digest("SHA-256",bytes), contentHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,"0")).join("");
  await env.UPLOADS.put(fileKey,bytes,{httpMetadata:{contentType:file.type},customMetadata:{creator,contestId,contentHash}});
  const bond = contest.asset_type === "Photo / Visual" ? 500_000 : contest.asset_type === "Short Video" || contest.asset_type === "Static Page" ? 1_000_000 : 2_000_000;
  if (existing) await database.prepare(`UPDATE submissions SET version=?,file_key=?,original_name=?,mime_type=?,byte_size=?,eligibility='CHECKING',submitted_at=? WHERE id=?`).bind(version,fileKey,file.name,file.type,file.size,new Date().toISOString(),submissionId).run();
  else await database.prepare(`INSERT INTO submissions (id,contest_id,creator,version,file_key,original_name,mime_type,byte_size,bond_micros,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(submissionId,contestId,creator,version,fileKey,file.name,file.type,file.size,bond,new Date().toISOString()).run();
  await database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,creator,"SUBMISSION_UPLOADED",JSON.stringify({submissionId,version,contentHash}),new Date().toISOString()).run();
  return json({ submissionId, version, contentHash, eligibility: "CHECKING", bondMicros: bond, bondRequired: !existing, replacementsRemaining: 3 - version }, 201);
}

async function eligibility(request, env, submissionId) {
  if (!request.headers.get("x-kotae-worker-secret")) return json({ error: "Unauthorized evaluator" }, 401);
  const body = await request.json(), status = body.status === "VALID" ? "VALID" : "NEEDS_FIX";
  const database = await db(env);
  await database.prepare(`UPDATE submissions SET eligibility=?,reason_codes_json=?,ai_message=? WHERE id=?`).bind(status,JSON.stringify(body.reasonCodes||[]),body.message||null,submissionId).run();
  return json({ submissionId, eligibility: status });
}

async function settle(request, env, contestId) {
  const body = await request.json(), database = await db(env);
  const contest = await database.prepare(`SELECT requester,status FROM contests WHERE id=?`).bind(contestId).first();
  if (!contest || contest.requester !== actor(request)) return json({ error: "Only requester can select the winner" }, 403);
  const winner = await database.prepare(`SELECT id FROM submissions WHERE id=? AND contest_id=? AND eligibility='VALID'`).bind(body.submissionId,contestId).first();
  if (!winner) return json({ error: "Winner must be valid" }, 422);
  await database.prepare(`UPDATE contests SET status='SETTLED',winner_submission_id=?,tx_hash=? WHERE id=?`).bind(body.submissionId,body.txHash,contestId).run();
  return json({ status: "SETTLED", winnerSubmissionId: body.submissionId, txHash: body.txHash });
}

async function cancelContest(request, env, contestId) {
  const database = await db(env);
  const contest = await database.prepare(`SELECT requester,status,budget_micros FROM contests WHERE id=?`).bind(contestId).first();
  if (!contest) return json({ error: "Contest not found" }, 404);
  if (contest.requester !== actor(request)) return json({ error: "Only requester can cancel the contest" }, 403);
  const count = await database.prepare(`SELECT COUNT(*) AS total FROM submissions WHERE contest_id=?`).bind(contestId).first();
  if (contest.status !== "OPEN" || Number(count?.total || 0) !== 0) return json({ error: "Cancellation is only available before the first submission" }, 409);
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`UPDATE contests SET status='CANCELLED' WHERE id=? AND status='OPEN'`).bind(contestId),
    database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,actor(request),"CONTEST_CANCELLED",JSON.stringify({refundMicros:contest.budget_micros}),now),
  ]);
  return json({ contestId, status: "CANCELLED", refundMicros: contest.budget_micros });
}

async function addSlotPack(request, env, contestId) {
  const database = await db(env);
  const contest = await database.prepare(`SELECT requester,status,asset_type,valid_cap,budget_micros FROM contests WHERE id=?`).bind(contestId).first();
  if (!contest) return json({ error: "Contest not found" }, 404);
  if (contest.requester !== actor(request)) return json({ error: "Only requester can add slots" }, 403);
  const baseCap = contest.asset_type === "Photo / Visual" ? 10 : 5;
  const packs = Math.max(0, Math.floor((contest.valid_cap - baseCap) / 5));
  if (contest.status !== "OPEN" || packs >= 3) return json({ error: "Slot pack limit reached or contest is closed" }, 409);
  const feeMicros = Math.floor(contest.budget_micros / 10), participationMicros = Math.floor(feeMicros / 2), validCap = contest.valid_cap + 5, now = new Date().toISOString();
  await database.batch([
    database.prepare(`UPDATE contests SET valid_cap=? WHERE id=? AND status='OPEN'`).bind(validCap,contestId),
    database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,actor(request),"SLOTS_ADDED",JSON.stringify({validCap,feeMicros,participationMicros,platformMicros:feeMicros-participationMicros}),now),
  ]);
  return json({ contestId, validCap, slotPacks: packs + 1, feeMicros, participationMicros, platformMicros: feeMicros - participationMicros });
}

async function settleAfterTimeout(request, env, contestId) {
  const body = await request.json().catch(() => ({})), database = await db(env);
  const contest = await database.prepare(`SELECT status,budget_micros,submission_deadline FROM contests WHERE id=?`).bind(contestId).first();
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
  const status = validCount > 0 ? "TIMEOUT_SETTLED" : "REFUNDED_NO_VALID", now = new Date().toISOString();
  const allocation = { validCount, eachCreatorMicros, requesterRefundMicros, platformMicros, slotFeesMicros, txHash: body.txHash || null };
  await database.batch([
    database.prepare(`UPDATE contests SET status=?,tx_hash=? WHERE id=? AND status='OPEN'`).bind(status,body.txHash||null,contestId),
    database.prepare(`INSERT INTO events (contest_id,actor,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`).bind(contestId,actor(request),"TIMEOUT_SETTLED",JSON.stringify(allocation),now),
  ]);
  return json({ contestId, status, ...allocation, winnerSubmissionId: null, rightsTransferred: false });
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return json({ ok: true, chainId: 10143, token: "AUSD" });
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
