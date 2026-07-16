import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectedSettlement, timeoutSettlement } from "../contracts/model.mjs";

test("85/5/10 selection preserves every AUSD micro-unit", () => {
  const result = selectedSettlement(12_000_001, 0, 4);
  assert.equal(result.winner + result.eachLoser * 3 + result.platform, 12_000_001);
  assert.equal(result.platform, 1_200_001);
});

test("single valid creator receives the complete 90% creator allocation", () => {
  assert.deepEqual(selectedSettlement(10_000_000, 0, 1), { winner: 9_000_000, eachLoser: 0, platform: 1_000_000 });
});

test("slot fee is split equally between participation and platform", () => {
  const result = selectedSettlement(20_000_000, 2_000_000, 3);
  assert.equal(result.platform, 3_000_000);
  assert.equal(result.winner + result.eachLoser * 2 + result.platform, 22_000_000);
});

test("no valid work refunds 90% after timeout", () => {
  assert.deepEqual(timeoutSettlement(20_000_000, 0, 0), { requester: 18_000_000, eachCreator: 0, platform: 2_000_000 });
});

test("valid creators evenly share the 90% timeout allocation", () => {
  assert.deepEqual(timeoutSettlement(12_000_000, 0, 3), { requester: 0, eachCreator: 3_600_000, platform: 1_200_000 });
});

test("timeout rounding preserves every AUSD micro-unit", () => {
  const result = timeoutSettlement(10_000_001, 1_000_001, 3);
  assert.equal(result.requester + result.eachCreator * 3 + result.platform, 11_000_002);
});

test("contract keeps creative choice away from eligibility oracle", async () => {
  const source = await readFile(new URL("../contracts/src/KotaeEscrow.sol", import.meta.url), "utf8");
  assert.match(source, /msg\.sender != contest\.requester/);
  assert.match(source, /msg\.sender != eligibilityOracle/);
  assert.match(source, /contract KotaeEscrow/);
  assert.match(source, /cancelBeforeFirstSubmission/);
  assert.match(source, /existing\.version >= 3/);
  assert.match(source, /ShortVideo/);
  assert.match(source, /AssetType\.ShortVideo \? 8e6/);
});
