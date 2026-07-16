import { encodeFunctionData, isAddress, keccak256, parseAbi, parseUnits, stringToHex } from "viem";

const MONAD_CHAIN_ID = "0x279f";
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const ESCROW_ABI = parseAbi([
  "function createContest(uint8 assetType, uint128 baseBudget, uint40 submissionDeadline, uint16 validCap, bytes32 briefHash) returns (uint256 contestId)",
]);
const ASSET_TYPE = { "Photo / Visual": 0, "Static Page": 1, "Micro Tool": 2, "Short Video": 3 };

const fallbackContests = [
  { id:"strawberry-soda", title:"New strawberry soda launch poster", type:"Photo / Visual", brief:"Design a square social media poster for a new strawberry soda. Make the drink instantly recognizable, fresh, playful, and premium.", budget:12, deadline:"2d 14h", validCount:4, cap:10, submissions:4, status:"OPEN", requester:"0x7A2c…91F0", demoTheme:"strawberry", must:["Pink strawberry soda bottle or glass","Fresh strawberries and visible bubbles","Readable at mobile size","Square social media composition"], avoid:["Unrelated flavors","Generic stock layout","Health or nutrition claims"] },
  { id:"cafe-reel", title:"15-second night café launch reel", type:"Short Video", brief:"Create a vertical short video that makes a late-night café feel atmospheric and worth visiting.", budget:12, deadline:"3d 08h", validCount:2, cap:5, submissions:3, status:"OPEN", requester:"0x61Bc…04D2", must:["9:16 vertical composition","15 seconds or less","Readable café name and opening time"], avoid:["Copyrighted music","Rapid flashing","Unlicensed stock footage"] },
  { id:"cafe-page", title:"One-page site for a night café", type:"Static Page", brief:"A responsive, atmospheric page that turns late-night visitors into table reservations.", budget:28, deadline:"4d 03h", validCount:3, cap:5, submissions:4, status:"OPEN", requester:"0x19bE…A240", must:["Mobile-first","Menu section","Reservation CTA"], avoid:["Stock coffee photos","Heavy animation"] },
  { id:"invoice-tool", title:"Freelance rate calculator", type:"Micro Tool", brief:"A tiny browser tool that converts a target monthly income into a defensible hourly and project rate.", budget:42, deadline:"6d 19h", validCount:1, cap:5, submissions:1, status:"OPEN", requester:"0x3CD9…782B", must:["Runs without backend","Clear assumptions","Export summary"], avoid:["Sign-up wall","Tracking scripts"] },
  { id:"timeout-demo", title:"Editorial poster set · timeout ready", type:"Photo / Visual", brief:"Create an editorial poster series for an independent design festival.", budget:10, deadline:"Ended · 48h elapsed", validCount:3, cap:10, submissions:4, status:"JUDGING_EXPIRED", requester:"0x4E10…37B8", must:["Festival date","Three coordinated posters","Print-ready composition"], avoid:["Stock templates","Unreadable event details"] }
];

const state = { contests: [], filter: "All", sort: "ending", wallet: null, authMode: "demo", chain: { configured: false, ausdAddress: null, escrowAddress: null }, currentContest: null, creatorVersions: {}, creatorEligibility: {}, submissionHashes: {} };
const views = [...document.querySelectorAll("[data-view]")];
const toast = document.querySelector("#toast");

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 3500);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
}

function requireOnchainConfiguration() {
  if (!window.ethereum) throw new Error("Install an EVM wallet to fund a contest on Monad Testnet.");
  if (!state.wallet) throw new Error("Connect and verify your wallet first.");
  if (!state.chain.configured || !isAddress(state.chain.ausdAddress || "") || !isAddress(state.chain.escrowAddress || "")) {
    throw new Error("KOTAE escrow and AUSD addresses are not configured yet.");
  }
}

async function sendWalletTransaction(to, abi, functionName, args) {
  const data = encodeFunctionData({ abi, functionName, args });
  return window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: state.wallet, to, data }] });
}

async function waitForFinalizedTransaction(txHash) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [receipt, finalized] = await Promise.all([
      window.ethereum.request({ method: "eth_getTransactionReceipt", params: [txHash] }),
      window.ethereum.request({ method: "eth_getBlockByNumber", params: ["finalized", false] }),
    ]);
    if (receipt?.status === "0x0") throw new Error("The Monad transaction reverted.");
    if (receipt?.blockNumber && finalized?.number && BigInt(receipt.blockNumber) <= BigInt(finalized.number)) return receipt;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error("The transaction was sent but is still awaiting Monad finality. Try again shortly.");
}

function briefHash(payload) {
  return keccak256(stringToHex(JSON.stringify({
    title: String(payload.title || "").trim(),
    brief: String(payload.brief || "").trim(),
    must: Array.isArray(payload.must) ? payload.must.map(String) : [],
    avoid: Array.isArray(payload.avoid) ? payload.avoid.map(String) : [],
  })));
}

async function fundContestOnchain(payload) {
  requireOnchainConfiguration();
  const amount = parseUnits(String(payload.budget), 6);
  const approveHash = await sendWalletTransaction(state.chain.ausdAddress, ERC20_ABI, "approve", [state.chain.escrowAddress, amount]);
  await waitForFinalizedTransaction(approveHash);
  const contestHash = await sendWalletTransaction(state.chain.escrowAddress, ESCROW_ABI, "createContest", [
    ASSET_TYPE[payload.type], amount, BigInt(Math.floor(new Date(payload.deadlineAt).getTime() / 1000)), Number(payload.cap), briefHash(payload),
  ]);
  await waitForFinalizedTransaction(contestHash);
  return contestHash;
}

function contestRow(contest) {
  const timeoutReady = contest.status === "JUDGING_EXPIRED";
  return `<article class="contest-row" data-contest-id="${escapeHtml(contest.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(contest.title)}">
    <div class="type">${escapeHtml(contest.type)}</div>
    <h3>${escapeHtml(contest.title)}</h3>
    <p>${escapeHtml(contest.brief)}</p>
    <div class="valid"><strong>${contest.validCount}/${contest.cap}</strong><small>VALID ENTRIES</small></div>
    <div class="time ${timeoutReady ? "timeout-ready" : ""}"><strong>${timeoutReady ? "READY" : escapeHtml(contest.deadline)}</strong><small>${timeoutReady ? "TIMEOUT SETTLEMENT" : "REMAINING"}</small></div>
    <span class="arrow">↗</span>
  </article>`;
}

function renderContests() {
  const ordered = [...state.contests]
    .filter(c => state.filter === "All" || c.type === state.filter)
    .sort((a,b) => state.sort === "budget" ? b.budget - a.budget : a.deadline.localeCompare(b.deadline));
  document.querySelector("#homeContestList").innerHTML = state.contests.slice(0,3).map(contestRow).join("");
  document.querySelector("#browseContestList").innerHTML = ordered.map(contestRow).join("") || `<p class="empty-state">No open briefs in this category yet.</p>`;
  document.querySelector("#dashboardContestList").innerHTML = state.contests.slice(0,2).map(contestRow).join("");
  bindContestRows();
}

function bindContestRows() {
  document.querySelectorAll("[data-contest-id]").forEach(row => {
    const open = () => openContest(row.dataset.contestId);
    row.onclick = open;
    row.onkeydown = event => { if (event.key === "Enter" || event.key === " ") open(); };
  });
}

function navigate(route) {
  const target = ["home","browse","create","contest","dashboard"].includes(route) ? route : "home";
  views.forEach(view => view.classList.toggle("active", view.dataset.view === target));
  history.replaceState(null, "", `#${target}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.querySelector("main").focus({ preventScroll: true });
}

document.querySelectorAll("[data-route]").forEach(link => link.addEventListener("click", event => {
  event.preventDefault(); navigate(link.dataset.route);
}));

document.querySelector("#demoContestButton").addEventListener("click", () => openContest("strawberry-soda"));

function entryCard(number, status = "VALID", theme = "", canSelect = true) {
  const strawberryEntries = ["Fresh Splash", "Bold Launch", "Studio Pop", "Illustrated Fizz"];
  const title = theme === "strawberry" ? strawberryEntries[number - 1] : `Creator outcome ${number}`;
  const previewClass = theme === "strawberry" ? ` strawberry-preview strawberry-preview-${number}` : "";
  return `<article class="entry-card"><div class="entry-preview${previewClass}" role="img" aria-label="${escapeHtml(title)} watermarked submission preview"></div><header><span>ENTRY ${String(number).padStart(2,"0")}</span><span class="${status === "VALID" ? "valid-badge" : "checking-badge"}">${status}</span></header><p><strong>${escapeHtml(title)}</strong><span>System watermark applied · Original stays private</span></p><button class="select-winner" data-entry="${number}" ${status !== "VALID" || !canSelect ? "disabled" : ""}>${canSelect ? "Select this outcome" : "Judging window expired"}</button></article>`;
}

function openContest(id) {
  const contest = state.contests.find(item => item.id === id) || fallbackContests.find(item => item.id === id) || state.contests[0] || fallbackContests[0];
  state.currentContest = contest;
  const percent = Math.min(100, Math.round((contest.validCount / contest.cap) * 100));
  const isOpen = contest.status === "OPEN";
  const timeoutReady = contest.status === "JUDGING_EXPIRED";
  const entries = Array.from({length: Math.min(contest.validCount, 4)}, (_,i) => entryCard(i+1, "VALID", contest.demoTheme, isOpen)).join("") || `<p>No valid entries were approved.</p>`;
  const cancelAction = contest.status === "OPEN" && contest.submissions === 0 ? `<button class="cancel-contest" id="cancelContest">Cancel & refund before first submission</button>` : "";
  const creatorVersion = state.creatorVersions[contest.id] || 0;
  const submitLabel = creatorVersion === 0 ? "Submit finished work ↗" : creatorVersion < 3 ? `Replace your submission · ${3 - creatorVersion} left` : "Replacement limit reached";
  const slotPacks = contest.slotPacks || 0;
  const slotAction = contest.status === "OPEN" && slotPacks < 3 ? `<button class="slot-pack-button" id="addSlotPack">Add 5 valid slots · ${(contest.budget * .10).toFixed(2)} AUSD</button>` : "";
  const submissionAction = isOpen ? `<button class="submit-button" id="submitEntry" ${creatorVersion >= 3 ? "disabled" : ""}>${submitLabel}</button>` : timeoutReady ? `<button class="timeout-button" id="settleTimeout">Settle after requester timeout</button>` : "";
  document.querySelector("#contestDetail").innerHTML = `<div class="detail-shell">
    <div class="detail-head">
      <div><button class="back-link" data-back>← Back to open briefs</button><div class="eyebrow"><span>LIVE</span> ${escapeHtml(contest.type)}</div><h1>${escapeHtml(contest.title)}</h1><p class="brief">${escapeHtml(contest.brief)}</p><div class="detail-meta"><span>REQUESTER<b>${escapeHtml(contest.requester)}</b></span><span>DEADLINE<b>${escapeHtml(contest.deadline)}</b></span><span>ONCHAIN SUBMISSIONS<b>${contest.submissions}</b></span></div></div>
      <aside class="prize-box"><span>BASE PRIZE LOCKED</span><strong>${contest.budget.toFixed(2)}</strong><small>AUSD · MONAD TESTNET</small><div class="capacity"><div><i style="width:${percent}%"></i></div><p><span>${contest.validCount} VALID</span><span>${contest.cap} MAX</span></p></div>${submissionAction}${slotAction}${cancelAction}</aside>
    </div>
    <div class="detail-body"><section class="rules"><div class="section-kicker">THE BRIEF</div><div class="rule-group"><h2>Acceptance rules</h2><h3>Must include</h3><ul>${(contest.must || []).map(rule=>`<li>${escapeHtml(rule)}</li>`).join("")}</ul></div><div class="rule-group"><h3>Avoid</h3><ul>${(contest.avoid || []).map(rule=>`<li>${escapeHtml(rule)}</li>`).join("")}</ul></div><div class="rule-group"><h3>License</h3><ul><li>Commercial rights transfer to requester only for the selected work</li><li>Losing creators keep full rights to their work</li></ul></div></section>
    <section class="entries"><div class="section-kicker">SYSTEM-CHECKED PREVIEWS</div><h2>${contest.validCount} valid outcomes</h2><div class="entry-grid">${entries}</div></section></div>
  </div>`;
  document.querySelector("[data-back]").onclick = () => navigate("browse");
  document.querySelector("#submitEntry")?.addEventListener("click", showSubmitDialog);
  document.querySelector("#settleTimeout")?.addEventListener("click", () => requestTimeoutSettlement(contest));
  document.querySelector("#addSlotPack")?.addEventListener("click", () => requestSlotPack(contest));
  document.querySelector("#cancelContest")?.addEventListener("click", () => requestContestCancellation(contest));
  document.querySelectorAll(".select-winner").forEach(button => button.onclick = () => settleContest(contest, button.dataset.entry));
  navigate("contest");
}

function modalShell(content) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${content}</div>`;
  modal.addEventListener("click", event => { if (event.target === modal || event.target.closest("[data-close]")) modal.remove(); });
  document.body.append(modal);
  return modal;
}

async function fileDigest(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,"0")).join("");
}

function readVideoDuration(file) {
  return new Promise(resolve => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const timer = setTimeout(() => done(0), 5000);
    const done = value => { if (settled) return; settled = true; clearTimeout(timer); URL.revokeObjectURL(url); video.remove(); resolve(value); };
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number(video.duration));
    video.onerror = () => done(0);
    video.src = url;
  });
}

async function reviewSubmission(file, contest, hash) {
  const name = file.name.toLowerCase();
  const imageType = ["image/png","image/jpeg","image/webp"].includes(file.type) || /\.(png|jpe?g|webp)$/.test(name);
  const zipType = ["application/zip","application/x-zip-compressed"].includes(file.type) || name.endsWith(".zip");
  const videoType = ["video/mp4","video/webm"].includes(file.type) || /\.(mp4|webm)$/.test(name);
  const formatPass = contest.type === "Photo / Visual" ? imageType : contest.type === "Short Video" ? videoType : zipType;
  const maxSize = contest.type === "Short Video" ? 50_000_000 : contest.type === "Photo / Visual" ? 20_000_000 : 10_000_000;
  const duration = contest.type === "Short Video" && videoType ? await readVideoDuration(file) : null;
  const duplicate = Object.values(state.submissionHashes).flat().includes(hash);
  const checks = [
    { label:"File integrity", detail:file.size >= 1024 ? `${(file.size/1024).toFixed(1)} KB readable` : "File is empty or too small", pass:file.size >= 1024, source:"SYSTEM" },
    { label:"Format & size", detail:formatPass && file.size <= maxSize ? `${file.type || "Extension verified"} within limit` : "Unsupported format or file exceeds limit", pass:formatPass && file.size <= maxSize, source:"SYSTEM" },
    { label:"Duplicate screening", detail:duplicate ? "Identical SHA-256 already submitted" : `Unique hash ${hash.slice(0,8)}…`, pass:!duplicate, source:"SYSTEM" },
    { label:"Brief requirements", detail:`Matches ${Math.min(5,(contest.must || []).length)} required constraints`, pass:true, source:"AI" },
    { label:"Prohibited content", detail:`No conflict with ${(contest.avoid || []).length} avoid rules`, pass:true, source:"AI" },
    { label:"Rights attestation", detail:"Creator ownership confirmation recorded", pass:true, source:"CREATOR" }
  ];
  if (contest.type === "Short Video") checks.splice(2,0,{ label:"Video duration", detail:duration > 0 && duration <= 30 ? `${duration.toFixed(1)} seconds` : duration > 30 ? `${duration.toFixed(1)} seconds exceeds the 30-second limit` : "Video metadata could not be read", pass:duration > 0 && duration <= 30, source:"SYSTEM" });
  return { valid:checks.every(check => check.pass), checks, hash, reasonCodes:checks.filter(check => !check.pass).map(check => check.label.toUpperCase().replaceAll(" ","_")) };
}

function showEligibilityReport(contest, file, review, version, replacing) {
  const status = review.valid ? "VALID" : "NEEDS FIX";
  const rows = review.checks.map(check => `<li class="${check.pass ? "pass" : "fail"}"><i>${check.pass ? "✓" : "!"}</i><div><strong>${escapeHtml(check.label)}</strong><span>${escapeHtml(check.detail)}</span></div><em>${check.source}</em></li>`).join("");
  const report = modalShell(`<button class="modal-close" data-close>×</button><div class="section-kicker">ELIGIBILITY REVIEW · VERSION ${version}</div><div class="eligibility-result ${review.valid ? "valid" : "needs-fix"}"><span>${status}</span><strong>${review.valid ? "Eligible for requester review" : "Fix the flagged file checks"}</strong><p>${review.valid ? "A protected preview can now enter the competition." : "No valid-entry slot was consumed and no new bond was locked."}</p></div><ul class="eligibility-checks">${rows}</ul><div class="eligibility-boundary"><strong>AI checks eligibility—not taste.</strong><span>The requester still chooses the winner from all valid outcomes.</span></div><button class="primary-button wide" id="eligibilityContinue">${review.valid ? "View watermarked entry" : replacing ? "Choose another replacement" : "Return to submission"} <span>→</span></button><small class="modal-note">SHA-256 ${review.hash.slice(0,16)}… · ${escapeHtml(file.name)}</small>`);
  report.querySelector(".modal").classList.add("eligibility-modal");
  report.querySelector("#eligibilityContinue").onclick = () => { report.remove(); openContest(contest.id); };
}

function showSubmitDialog() {
  const contest = state.currentContest;
  const bonds = {"Photo / Visual":0.5,"Short Video":1,"Static Page":1,"Micro Tool":2};
  const requirements = contest.type === "Photo / Visual" ? "PNG, JPEG or WebP · max 20MB" : contest.type === "Short Video" ? "MP4 or WebM · max 50MB · up to 30 seconds" : "ZIP with index.html · max 10MB, plus desktop and mobile screenshots";
  const currentVersion = state.creatorVersions[contest.id] || 0;
  if (currentVersion >= 3) return notify("Replacement limit reached: the initial submission and two updates are already recorded.");
  const replacing = currentVersion > 0;
  const nextVersion = currentVersion + 1;
  const replacementsAfterUpload = Math.max(0, 3 - nextVersion);
  const actionLabel = replacing ? "Replace work & rerun eligibility" : "Deposit bond & run eligibility check";
  const modal = modalShell(`<button class="modal-close" data-close>×</button><div class="section-kicker">CREATOR SUBMISSION · VERSION ${nextVersion}</div><h2>${replacing ? "Replace your submission" : "Submit finished work"}</h2><p>${escapeHtml(requirements)}</p><label class="drop-zone"><input type="file" id="entryFile" required /><b>${replacing ? "Choose the corrected original" : "Drop your original here"}</b><span>The system creates a watermarked preview. Requesters cannot access the original before settlement.</span></label><div class="bond-row"><span>Refundable submission bond</span><strong>${replacing ? "Already secured" : `${bonds[contest.type]} AUSD`}</strong></div><label class="check-row"><input id="ownershipCheck" type="checkbox" /><span>I created or control the rights to this work and it follows the brief.</span></label><button class="primary-button wide" id="runCheck">${actionLabel} <span>↗</span></button><small class="modal-note">${replacementsAfterUpload} replacement${replacementsAfterUpload === 1 ? "" : "s"} will remain after this upload. AI checks eligibility only—it never chooses the winner.</small>`);
  modal.querySelector("#runCheck").onclick = async () => {
    const file = modal.querySelector("#entryFile").files[0];
    if (!file || !modal.querySelector("#ownershipCheck").checked) return notify("Add a file and confirm ownership first.");
    const button = modal.querySelector("#runCheck");
    button.disabled = true; button.textContent = "Running secure file preflight…";
    const hash = await fileDigest(file);
    const review = await reviewSubmission(file, contest, hash);
    if (!review.valid) {
      modal.remove(); showEligibilityReport(contest, file, review, nextVersion, replacing); return;
    }
    button.textContent = replacing ? "Uploading replacement privately…" : "Locking bond & uploading privately…";
    let recordedVersion = nextVersion;
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch(`/api/contests/${encodeURIComponent(contest.id)}/submissions`, { method:"POST", headers:{"x-wallet-address":state.wallet || "demo:creator"}, body:form });
      if (response.ok) recordedVersion = Number((await response.json()).version || nextVersion);
      else if (response.status !== 404) {
        const result = await response.json().catch(() => ({}));
        button.disabled = false; button.innerHTML = `${actionLabel} <span>↗</span>`;
        return notify(result.error || "Submission could not be recorded.");
      }
    } catch {
      // Static hackathon demo: preserve the same interaction without a bound Worker.
    }
    button.textContent = "AI checking file integrity and brief fit…";
    await new Promise(resolve => setTimeout(resolve, 1200));
    state.creatorVersions[contest.id] = recordedVersion;
    state.submissionHashes[contest.id] = [...(state.submissionHashes[contest.id] || []), hash];
    const wasValid = state.creatorEligibility[contest.id] === "VALID";
    state.creatorEligibility[contest.id] = "VALID";
    if (!replacing) contest.submissions += 1;
    if (!wasValid) contest.validCount = Math.min(contest.cap, contest.validCount + 1);
    modal.remove(); showEligibilityReport(contest, file, review, recordedVersion, replacing);
  };
}

function requestContestCancellation(contest) {
  const modal = modalShell(`<button class="modal-close" data-close>×</button><div class="section-kicker">BEFORE THE FIRST SUBMISSION</div><h2>Cancel this contest?</h2><p>No work has been submitted, so the complete locked budget can still be returned. Cancellation becomes unavailable immediately after the first submission.</p><div class="refund-box"><span>FULL REFUND</span><strong>${contest.budget.toFixed(2)} AUSD</strong><small>Returned to the requester</small></div><button class="danger-button wide" id="confirmCancellation">Cancel contest & refund AUSD</button><small class="modal-note">This action closes the brief and cannot be reversed.</small>`);
  modal.querySelector("#confirmCancellation").onclick = async () => {
    const button = modal.querySelector("#confirmCancellation");
    button.disabled = true; button.textContent = "Checking submission count…";
    try {
      const response = await fetch(`/api/contests/${encodeURIComponent(contest.id)}/cancel`, { method:"POST", headers:{"x-wallet-address":state.wallet || contest.requester} });
      if (!response.ok && response.status !== 404) {
        const result = await response.json().catch(() => ({}));
        button.disabled = false; button.textContent = "Cancel contest & refund AUSD";
        return notify(result.error || "Cancellation is no longer available.");
      }
    } catch {
      // Static hackathon demo: the contract remains the source of truth in production.
    }
    contest.status = "CANCELLED";
    state.contests = state.contests.filter(item => item.id !== contest.id);
    modal.remove(); renderContests(); showCancellationReceipt(contest);
  };
}

function showCancellationReceipt(contest) {
  const receipt = modalShell(`<button class="modal-close" data-close>×</button><div class="section-kicker receipt-kicker"><i></i> REFUND CONFIRMED</div><h2>Contest cancelled.</h2><p>The brief closed before any creator submitted work, so no review, storage, or eligibility cost was incurred.</p><div class="refund-box confirmed"><span>RETURNED TO REQUESTER</span><strong>${contest.budget.toFixed(2)} AUSD</strong><small>100% of the locked contest budget</small></div><div class="cancellation-proof"><span>SUBMISSIONS</span><strong>0</strong><span>STATUS</span><strong>CANCELLED</strong></div><button class="primary-button wide" id="returnToBriefs">Return to open briefs <span>→</span></button>`);
  receipt.querySelector("#returnToBriefs").onclick = () => { receipt.remove(); navigate("browse"); };
}

function requestSlotPack(contest) {
  const fee = contest.budget * .10;
  const participationAdd = fee / 2;
  const platformAdd = fee - participationAdd;
  const nextCap = contest.cap + 5;
  const modal = modalShell(`<button class="modal-close" data-close>×</button><div class="section-kicker">EXPAND THE COMPETITION</div><h2>Add five valid-entry slots?</h2><p>Only submissions that pass eligibility consume a slot. The base winner prize remains unchanged.</p><div class="slot-preview"><div><span>NEW VALID CAP</span><strong>${nextCap}</strong></div><div><span>ADD-ON FEE</span><strong>${fee.toFixed(2)} AUSD</strong></div></div><div class="settlement-table"><div><span>Added to participation pool</span><strong>${participationAdd.toFixed(2)} AUSD</strong></div><div><span>Additional validation & operations</span><strong>${platformAdd.toFixed(2)} AUSD</strong></div></div><button class="primary-button wide" id="confirmSlotPack">Pay fee & add five slots <span>↗</span></button><small class="modal-note">Maximum three add-on packs per contest. This fee is locked with the contest and is not part of the 85% base winner prize.</small>`);
  modal.querySelector("#confirmSlotPack").onclick = async () => {
    const button = modal.querySelector("#confirmSlotPack");
    button.disabled = true; button.textContent = "Locking add-on fee in AUSD…";
    let confirmedCap = nextCap;
    let confirmedFee = fee;
    try {
      const response = await fetch(`/api/contests/${encodeURIComponent(contest.id)}/slots`, { method:"POST", headers:{"x-wallet-address":state.wallet || contest.requester} });
      if (response.ok) {
        const result = await response.json(); confirmedCap = Number(result.validCap || nextCap); confirmedFee = Number(result.feeMicros || fee * 1_000_000) / 1_000_000;
      } else if (response.status !== 404) {
        const result = await response.json().catch(() => ({}));
        button.disabled = false; button.innerHTML = 'Pay fee & add five slots <span>↗</span>';
        return notify(result.error || "More slots cannot be added.");
      }
    } catch {
      // Static hackathon demo: mirror the contract result locally.
    }
    contest.cap = confirmedCap;
    contest.slotPacks = (contest.slotPacks || 0) + 1;
    contest.slotFees = (contest.slotFees || 0) + confirmedFee;
    modal.remove(); openContest(contest.id); notify(`Five slots added · valid cap is now ${confirmedCap}.`);
  };
}

function requestTimeoutSettlement(contest) {
  const slotFees = contest.slotFees || 0;
  const creatorPool = contest.budget * .90 + slotFees / 2;
  const platform = contest.budget * .10 + slotFees - slotFees / 2;
  const validCount = Number(contest.validCount || 0);
  const eachCreator = validCount > 0 ? creatorPool / validCount : 0;
  const requesterRefund = validCount === 0 ? creatorPool : 0;
  const distributionCopy = validCount > 0
    ? `${validCount} valid creators receive an equal share. No creator is declared the winner.`
    : "No valid work exists, so the creator allocation returns to the requester.";
  const modal = modalShell(`<button class="modal-close" data-close>×</button><div class="section-kicker">48-HOUR JUDGING WINDOW EXPIRED</div><h2>Release the locked AUSD?</h2><p>The requester did not choose an outcome in time. Anyone may trigger the contract's neutral timeout path.</p><div class="timeout-preview"><div><span>CREATOR POOL</span><strong>${creatorPool.toFixed(2)} AUSD</strong><small>${validCount > 0 ? `${eachCreator.toFixed(2)} each × ${validCount}` : "Returned to requester"}</small></div><div><span>KOTAE PROTOCOL</span><strong>${platform.toFixed(2)} AUSD</strong><small>Review, storage & operations</small></div></div><div class="timeout-boundary"><strong>No winner. No rights transfer.</strong><span>${distributionCopy}</span></div><button class="primary-button wide" id="confirmTimeout">Settle timeout on Monad <span>↗</span></button><small class="modal-note">Creator bonds are returned. Watermarked previews remain previews and every original stays private.</small>`);
  modal.querySelector("#confirmTimeout").onclick = async () => {
    const button = modal.querySelector("#confirmTimeout");
    button.disabled = true; button.textContent = "Confirming neutral settlement…";
    try {
      const response = await fetch(`/api/contests/${encodeURIComponent(contest.id)}/timeout-settle`, { method:"POST", headers:{"content-type":"application/json","x-wallet-address":state.wallet || "demo:settler"}, body:JSON.stringify({ txHash:"demo:timeout" }) });
      if (!response.ok && response.status !== 404) {
        const result = await response.json().catch(() => ({}));
        button.disabled = false; button.innerHTML = 'Settle timeout on Monad <span>↗</span>';
        return notify(result.error || "Timeout settlement is not available yet.");
      }
    } catch {
      // Static hackathon demo: mirror the contract allocation locally.
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    contest.status = validCount > 0 ? "TIMEOUT_SETTLED" : "REFUNDED_NO_VALID";
    modal.remove();
    showTimeoutReceipt(contest, validCount, eachCreator, requesterRefund, platform, creatorPool + platform);
  };
}

function showTimeoutReceipt(contest, validCount, eachCreator, requesterRefund, platform, totalSettled) {
  const headline = validCount > 0 ? "Creator pool distributed." : "Requester partially refunded.";
  const creatorValue = validCount > 0 ? `${eachCreator.toFixed(2)} AUSD each` : "0.00 AUSD";
  const receipt = modalShell(`<button class="modal-close" data-close>×</button><div class="section-kicker receipt-kicker"><i></i> TIMEOUT SETTLEMENT CONFIRMED</div><div class="receipt-head"><div><h2>${headline}</h2><p>The 48-hour requester judging window expired. The contract released funds without choosing a creative winner.</p></div><div class="receipt-chain"><span>MONAD TESTNET</span><strong>0x71be…48c0</strong><small>Demo transaction</small></div></div><div class="timeout-receipt-grid"><div><span>VALID CREATORS</span><strong>${validCount}</strong><small>${creatorValue}</small></div><div><span>REQUESTER REFUND</span><strong>${requesterRefund.toFixed(2)}</strong><small>AUSD</small></div><div><span>KOTAE PROTOCOL</span><strong>${platform.toFixed(2)}</strong><small>AUSD</small></div><div class="timeout-total"><span>TOTAL SETTLED</span><strong>${totalSettled.toFixed(2)}</strong><small>AUSD</small></div></div><div class="timeout-boundary receipt-boundary"><strong>No winner was selected.</strong><span>No exclusive original or commercial rights were transferred. All creator bonds were returned.</span></div><button class="primary-button wide" id="timeoutDashboard">Continue to dashboard <span>→</span></button><small class="modal-note">In production, the transaction hash links to Monad Explorer and each transfer is verifiable onchain.</small>`);
  receipt.querySelector(".modal").classList.add("receipt-modal");
  receipt.querySelector("#timeoutDashboard").onclick = () => { receipt.remove(); renderContests(); navigate("dashboard"); notify(`Timeout settled · ${totalSettled.toFixed(2)} AUSD released.`); };
}

function settleContest(contest, entry) {
  const slotFees = contest.slotFees || 0;
  const slotParticipation = slotFees / 2;
  const winner = contest.budget * .85;
  const participation = contest.validCount > 1 ? contest.budget * .05 + slotParticipation : 0;
  const winnerTotal = contest.validCount > 1 ? winner : contest.budget * .90 + slotParticipation;
  const platform = contest.budget * .10 + slotFees - slotParticipation;
  const totalSettled = contest.budget + slotFees;
  const modal = modalShell(`<button class="modal-close" data-close>×</button><div class="section-kicker">SETTLEMENT PREVIEW</div><h2>Select Entry ${String(entry).padStart(2,"0")}?</h2><p>This decision transfers the selected original and its commercial rights. It cannot be reversed after the transaction confirms.</p><div class="settlement-table"><div><span>Winner receives</span><strong>${winnerTotal.toFixed(2)} AUSD</strong></div><div><span>Valid runners-up share</span><strong>${participation.toFixed(2)} AUSD</strong></div><div><span>KOTAE protocol</span><strong>${platform.toFixed(2)} AUSD</strong></div></div><button class="primary-button wide" id="confirmWinner">Confirm winner on Monad <span>↗</span></button>`);
  modal.querySelector("#confirmWinner").onclick = async () => {
    const button = modal.querySelector("#confirmWinner"); button.disabled=true; button.textContent="Confirming settlement…";
    await new Promise(resolve=>setTimeout(resolve,900));
    contest.status="SETTLED"; contest.winnerEntry=Number(entry); modal.remove(); showSettlementReceipt(contest, entry, winnerTotal, participation, platform, totalSettled);
  };
}

function showSettlementReceipt(contest, entry, winnerTotal, participation, platform, totalSettled) {
  const previewClass = contest.demoTheme === "strawberry" ? ` strawberry-preview strawberry-preview-${entry}` : "";
  const receipt = modalShell(`<button class="modal-close" data-close>×</button><div class="section-kicker receipt-kicker"><i></i> SETTLEMENT CONFIRMED</div><div class="receipt-head"><div><h2>Outcome unlocked.</h2><p>The requester selected Entry ${String(entry).padStart(2,"0")}. The original and its commercial rights are now available.</p></div><div class="receipt-chain"><span>MONAD TESTNET</span><strong>0x9c1e…7a2f</strong><small>Demo transaction</small></div></div><div class="delivery-grid"><div class="delivery-preview${previewClass}" role="img" aria-label="Unlocked winning submission"></div><div class="delivery-status"><span>DELIVERED ORIGINAL</span><strong>Entry ${String(entry).padStart(2,"0")}</strong><ul><li>Watermark removed</li><li>Commercial rights transferred</li><li>${contest.validCount} creator bonds returned</li></ul></div></div><div class="settlement-table receipt-table"><div><span>Winner paid</span><strong>${winnerTotal.toFixed(2)} AUSD</strong></div><div><span>Valid runners-up share</span><strong>${participation.toFixed(2)} AUSD</strong></div><div><span>KOTAE protocol</span><strong>${platform.toFixed(2)} AUSD</strong></div><div class="receipt-total"><span>Total settled</span><strong>${totalSettled.toFixed(2)} AUSD</strong></div></div><button class="primary-button wide" id="receiptDashboard">Continue to dashboard <span>→</span></button><small class="modal-note">In production, the transaction hash links to Monad Explorer and the original is delivered from private storage.</small>`);
  receipt.querySelector(".modal").classList.add("receipt-modal");
  receipt.querySelector("#receiptDashboard").onclick = () => { receipt.remove(); renderContests(); navigate("dashboard"); notify(`Entry ${entry} unlocked · ${winnerTotal.toFixed(2)} AUSD paid to the winner.`); };
}

async function authenticateWallet(address) {
  const challengeResponse = await fetch("/api/auth/challenge", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({address})
  });
  const challenge = await challengeResponse.json().catch(()=>({}));
  if(!challengeResponse.ok) throw new Error(challenge.error || "Wallet verification could not start.");
  const signature = await window.ethereum.request({ method:"personal_sign", params:[challenge.message,address] });
  const verifyResponse = await fetch("/api/auth/verify", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({challengeId:challenge.challengeId,address,signature})
  });
  const verification = await verifyResponse.json().catch(()=>({}));
  if(!verifyResponse.ok) throw new Error(verification.error || "Wallet signature could not be verified.");
  return verification.address;
}

async function connectWallet() {
  if (!window.ethereum) {
    state.wallet = "0x000000000000000000000000000000000000dEaD";
    updateWalletUI(); notify("Demo wallet connected. Install a wallet to sign Monad transactions."); return;
  }
  try {
    await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{chainId:MONAD_CHAIN_ID}] });
  } catch (error) {
    if (error.code === 4902) await window.ethereum.request({ method:"wallet_addEthereumChain", params:[{chainId:MONAD_CHAIN_ID,chainName:"Monad Testnet",nativeCurrency:{name:"MON",symbol:"MON",decimals:18},rpcUrls:["https://testnet-rpc.monad.xyz"],blockExplorerUrls:["https://testnet.monadexplorer.com"]}] });
  }
  const accounts = await window.ethereum.request({ method:"eth_requestAccounts" });
  state.wallet = state.authMode === "signature" ? await authenticateWallet(accounts[0]) : accounts[0];
  const token = state.chain.ausdAddress ? `${state.chain.ausdAddress.slice(0,8)}…` : "not configured";
  updateWalletUI(); notify(`Wallet verified · AUSD ${token}`);
}

function updateWalletUI() {
  const short = state.wallet ? `${state.wallet.slice(0,6)}…${state.wallet.slice(-4)}` : "Not connected";
  document.querySelector("#walletButton").textContent = state.wallet ? short : "Connect wallet";
  document.querySelector("#walletAddress").textContent = short;
}

document.querySelector("#walletButton").onclick = () => connectWallet().catch(() => notify("Wallet connection was cancelled."));
document.querySelector("#filterTabs").onclick = event => {
  const button = event.target.closest("button"); if (!button) return;
  state.filter = button.dataset.filter;
  document.querySelectorAll("#filterTabs button").forEach(item=>item.classList.toggle("active",item===button)); renderContests();
};
document.querySelector("#sortSelect").onchange = event => { state.sort=event.target.value; renderContests(); };

document.querySelectorAll("#typeSelector button").forEach(button => button.onclick = () => {
  document.querySelectorAll("#typeSelector button").forEach(item=>item.classList.toggle("active",item===button));
  const budget = document.querySelector("[name=budget]"); budget.min=button.dataset.min; if(Number(budget.value)<Number(button.dataset.min)) budget.value=button.dataset.min;
  document.querySelector("#minBudget").textContent=`Minimum ${button.dataset.min} AUSD · ${button.dataset.cap} valid entry slots included`;
});

document.querySelectorAll("input[maxlength],textarea[maxlength]").forEach(field => field.addEventListener("input", () => {
  const counter=field.parentElement.querySelector("small i"); if(counter) counter.textContent=field.value.length;
}));

document.querySelector("#contestForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form=new FormData(event.currentTarget); const typeButton=document.querySelector("#typeSelector button.active");
  const deadline=String(form.get("deadline"));
  const deadlineParts=deadline.match(/(\d+)d\s*(\d+)h/);
  const deadlineOffset=((Number(deadlineParts?.[1] || 7) * 24) + Number(deadlineParts?.[2] || 0)) * 60 * 60 * 1000;
  const payload={ title:form.get("title"), brief:form.get("brief"), type:typeButton.dataset.type, budget:Number(form.get("budget")), deadline, deadlineAt:new Date(Date.now() + deadlineOffset).toISOString(), cap:Number(typeButton.dataset.cap), must:String(form.get("must")||"").split("\n").filter(Boolean).slice(0,5), avoid:String(form.get("avoid")||"").split("\n").filter(Boolean).slice(0,5) };
  const submit=event.submitter; submit.disabled=true; submit.textContent="Locking AUSD on Monad…";
  try {
    const headers={"content-type":"application/json"};
    if(state.wallet) headers["x-wallet-address"]=state.wallet;
    if(state.authMode === "signature") payload.txHash=await fundContestOnchain(payload);
    const response=await fetch("/api/contests",{method:"POST",headers,body:JSON.stringify(payload)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(result.error || "Contest could not be created.");
    state.contests.unshift(result.contest); renderContests(); openContest(result.contest.id); notify(`Contest funded · ${payload.budget.toFixed(2)} AUSD locked.`);
  } catch (error) {
    notify(error.message || "Contest could not be created.");
  } finally { submit.disabled=false; submit.innerHTML='Fund & open contest <span>↗</span>'; }
});

async function boot() {
  try {
    const healthResponse=await fetch("/api/health");
    const health=await healthResponse.json();
    state.authMode=health.walletWrites === "signature" ? "signature" : "demo";
    state.chain={ configured:Boolean(health.chainVerificationConfigured && health.ausdAddress && health.escrowAddress), ausdAddress:health.ausdAddress || null, escrowAddress:health.escrowAddress || null };
    if(state.authMode === "signature") {
      const sessionResponse=await fetch("/api/auth/session");
      if(sessionResponse.ok) state.wallet=(await sessionResponse.json()).address;
      updateWalletUI();
    }
  } catch {
    state.authMode="demo";
  }
  try { const response=await fetch("/api/contests"); if(!response.ok) throw new Error(); const remote=(await response.json()).contests; state.contests=remote.length?remote:[...fallbackContests]; }
  catch { state.contests=[...fallbackContests]; }
  renderContests();
  const route=location.hash.replace("#",""); navigate(["browse","create","dashboard"].includes(route)?route:"home");
}

window.addEventListener("hashchange", () => {
  const route = location.hash.replace("#", "");
  if (["home", "browse", "create", "dashboard"].includes(route)) navigate(route);
});

boot();
