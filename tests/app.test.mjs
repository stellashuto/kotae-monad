import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("product copy and critical transaction affordances render", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const phrase of ["KOTAE", "Buy the answer", "Not the attempts", "Explore live contests", "Short Video", "Fund & open contest", "Submit finished work", "Valid runners-up", "Monad Testnet"]) assert.match(html, new RegExp(phrase));
  assert.match(html, /<img[\s\S]*src="\/og\.png"[\s\S]*strawberry soda poster brief/);
  assert.match(html, /POST-HACKATHON ROADMAP/);
  assert.match(html, /app\.js\?v=5/);
  assert.match(html, /Creators sell what/);
  assert.match(html, /fixed AUSD price/);
});

test("production worker embeds the static site when an asset binding is unavailable", async () => {
  const [worker, buildScript] = await Promise.all([
    readFile(new URL("../worker/index.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /embeddedStaticResponse\(request\)/);
  assert.match(worker, /globalThis\.__KOTAE_STATIC_ASSETS__/);
  assert.match(worker, /"cache-control": "no-cache"/);
  assert.match(buildScript, /embeddedStaticAssets/);
  assert.match(buildScript, /"globalThis\.__KOTAE_STATIC_ASSETS__"/);
});

test("browser client targets Monad testnet and receives deployed addresses from runtime config", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /0x279f/);
  assert.match(app, /health\.ausdAddress/);
  assert.match(app, /health\.escrowAddress/);
  assert.match(app, /health\.ausdFaucetAddress/);
  assert.match(app, /fundContestOnchain/);
  assert.match(app, /requestTestAUSD/);
  assert.match(app, /deployKotaeEscrow/);
  assert.match(app, /encodeDeployData/);
  assert.match(app, /waitForFinalizedTransaction/);
  for (const method of ["submitWork", "cancelBeforeFirstSubmission", "addSlotPack", "chooseWinner", "settleAfterTimeout"]) assert.match(app, new RegExp(method));
  assert.doesNotMatch(app, /0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC/);
});

test("public contest data exposes chain identifiers without private originals", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(worker, /chainContestId: row\.chain_contest_id/);
  assert.match(worker, /chainSubmissionId: row\.chain_submission_id/);
  assert.match(worker, /request\.method === "GET"\) return listContestSubmissions/);
  assert.match(worker, /SELECT id,creator,version,eligibility,chain_submission_id,submitted_at FROM submissions/);
  assert.match(worker, /privateSubmissionFile/);
  assert.match(worker, /Private submission access denied/);
  assert.match(worker, /cache-control": "private, no-store"/);
});

test("live marketplace avoids placeholder contests and exposes real outcome controls", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(app, /fallbackContests/);
  assert.doesNotMatch(app, /Demo wallet connected/);
  assert.match(app, /Open private finished work/);
  assert.match(app, /recordEligibility/);
  assert.match(app, /Review objective eligibility/);
  assert.match(app, /awaiting oracle review/);
  assert.doesNotMatch(app, /source:"AI"/);
  assert.match(app, /Select this outcome/);
  assert.match(app, /Outcome unlocked/);
  assert.match(app, /Commercial rights transferred/);
  assert.match(app, /creator bonds returned/);
  assert.match(app, /Cancel & refund before first submission/);
  assert.match(app, /100% of the locked contest budget/);
  assert.match(app, /Replace work & rerun eligibility/);
  assert.match(app, /Already secured/);
  assert.match(app, /creatorVersions/);
  assert.match(app, /Add 5 valid slots/);
  assert.match(app, /Added to participation pool/);
  assert.match(app, /slotFees/);
  assert.match(app, /SHA-256/);
  assert.match(app, /Preflight checks mechanics—not taste/);
  assert.match(app, /NEEDS FIX/);
  assert.match(app, /MP4 or WebM/);
  assert.match(app, /Video duration/);
  assert.match(app, /30-second limit/);
  assert.match(css, /\.entry-proof/);
  assert.match(css, /\.private-file-link/);
  assert.match(css, /\.receipt-modal/);
});

test("cancellation API enforces requester and zero-submission rules", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(worker, /Only requester can cancel the contest/);
  assert.match(worker, /COUNT\(\*\) AS total FROM submissions/);
  assert.match(worker, /before the first submission/);
  assert.match(worker, /CONTEST_CANCELLED/);
  assert.match(worker, /\/cancel\$/);
});

test("submission API allows two replacements without a second bond", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(worker, /existing\.version >= 3/);
  assert.match(worker, /bondRequired: !existing/);
  assert.match(worker, /replacementsRemaining: 3 - version/);
  assert.match(worker, /UPDATE submissions SET version=/);
  assert.match(worker, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(worker, /Unsupported file format/);
  assert.match(worker, /SUBMISSION_UPLOADED/);
  assert.match(worker, /"Short Video": 8/);
  assert.match(worker, /video\/mp4/);
});

test("slot pack API adds five slots and splits its fee", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(worker, /Only requester can add slots/);
  assert.match(worker, /packs >= 3/);
  assert.match(worker, /valid_cap \+ 5/);
  assert.match(worker, /participationMicros/);
  assert.match(worker, /platformMicros/);
  assert.match(worker, /SLOTS_ADDED/);
});

test("timeout settlement releases funds without selecting a winner", async () => {
  const [app, worker, schema] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.js", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8")
  ]);
  assert.match(app, /requestTimeoutSettlement/);
  assert.match(app, /TIMEOUT SETTLEMENT CONFIRMED/);
  assert.match(app, /No winner was selected/);
  assert.match(app, /No exclusive original or commercial rights were transferred/);
  assert.match(app, /deadlineAt/);
  assert.match(worker, /48 \* 60 \* 60 \* 1000/);
  assert.match(worker, /eligibility='VALID'/);
  assert.match(worker, /TIMEOUT_SETTLED/);
  assert.match(worker, /\/timeout-settle\$/);
  assert.match(worker, /rightsTransferred: false/);
  assert.match(schema, /'Short Video'/);
});

test("production writes require wallet sessions and finalized chain receipts", async () => {
  const [build, source, auth, chain] = await Promise.all([
    readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.js", import.meta.url), "utf8"),
    readFile(new URL("../worker/auth.js", import.meta.url), "utf8"),
    readFile(new URL("../worker/chain.js", import.meta.url), "utf8")
  ]);
  assert.match(build, /bundle: true/);
  assert.match(source, /createWalletChallenge/);
  assert.match(source, /verifyEscrowTransaction/);
  assert.match(auth, /verifyMessage/);
  assert.match(auth, /HttpOnly; SameSite=Strict/);
  assert.match(chain, /eth_getTransactionReceipt/);
  assert.match(chain, /"finalized"/);
  assert.doesNotMatch(source, /demo:anonymous/);
});

test("demo wallets are validated and eligibility requires the configured oracle", async () => {
  const [{ authenticatedWallet }, source] = await Promise.all([
    import(new URL("../worker/auth.js", import.meta.url)),
    readFile(new URL("../worker/index.js", import.meta.url), "utf8")
  ]);
  const invalidWallet = await authenticatedWallet(new Request("https://kotae.test/api/contests", {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet-address": "demo:creator" },
    body: "{}"
  }), { KOTAE_AUTH_MODE: "demo" }, {});
  assert.equal(invalidWallet.status, 401);

  assert.match(source, /Eligibility oracle is not configured/);
  assert.match(source, /Only the configured eligibility oracle can record a decision/);
  assert.match(source, /actor: oracle, eventName: "EligibilityRecorded"/);
});
