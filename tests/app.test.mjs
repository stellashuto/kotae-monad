import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("product copy and critical transaction affordances render", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const phrase of ["KOTAE", "Buy the answer", "Not the attempts", "Try the live demo", "Short Video", "Fund & open contest", "Submit finished work", "Valid runners-up", "Monad Testnet"]) assert.match(html, new RegExp(phrase));
  assert.match(html, /<img[\s\S]*src="\/og\.png"[\s\S]*strawberry soda poster brief/);
  assert.match(html, /POST-HACKATHON ROADMAP/);
  assert.match(html, /Creators sell what/);
  assert.match(html, /fixed AUSD price/);
});

test("browser client targets official Monad testnet and AUSD", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC/);
  assert.match(app, /0x279f/);
});

test("featured contest continues the strawberry soda hero story", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(app, /New strawberry soda launch poster/);
  assert.match(app, /demoTheme:"strawberry"/);
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
  assert.match(app, /AI checks eligibility—not taste/);
  assert.match(app, /NEEDS FIX/);
  assert.match(app, /15-second night café launch reel/);
  assert.match(app, /MP4 or WebM/);
  assert.match(app, /Video duration/);
  assert.match(app, /30-second limit/);
  assert.match(css, /\.strawberry-preview-4/);
  assert.match(css, /background-image:url\('\/og\.png'\)/);
  assert.match(css, /\.receipt-modal/);
});

test("cancellation API enforces requester and zero-submission rules", async () => {
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /Only requester can cancel the contest/);
  assert.match(worker, /COUNT\(\*\) AS total FROM submissions/);
  assert.match(worker, /before the first submission/);
  assert.match(worker, /CONTEST_CANCELLED/);
  assert.match(worker, /\/cancel\$/);
});

test("submission API allows two replacements without a second bond", async () => {
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
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
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
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
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
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
