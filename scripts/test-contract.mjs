import assert from "node:assert/strict";
import { network } from "hardhat";
import { keccak256, toBytes } from "viem";

const AUSD = 1_000_000n;

async function setup() {
  const { viem } = await network.create({ network: "hardhatMainnet", chainType: "l1" });
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [deployer, requester, creatorA, creatorB, platform, oracle] = await viem.getWalletClients();
  const token = await viem.deployContract("MockAUSD");
  const escrow = await viem.deployContract("KotaeEscrow", [
    token.address,
    platform.account.address,
    oracle.account.address,
  ]);

  const asWallet = (name, address, wallet) =>
    viem.getContractAt(name, address, { client: { public: publicClient, wallet } });

  const requesterToken = await asWallet("MockAUSD", token.address, requester);
  const creatorAToken = await asWallet("MockAUSD", token.address, creatorA);
  const creatorBToken = await asWallet("MockAUSD", token.address, creatorB);
  const requesterEscrow = await asWallet("KotaeEscrow", escrow.address, requester);
  const creatorAEscrow = await asWallet("KotaeEscrow", escrow.address, creatorA);
  const creatorBEscrow = await asWallet("KotaeEscrow", escrow.address, creatorB);
  const oracleEscrow = await asWallet("KotaeEscrow", escrow.address, oracle);

  await token.write.mint([requester.account.address, 100n * AUSD]);
  await token.write.mint([creatorA.account.address, 10n * AUSD]);
  await token.write.mint([creatorB.account.address, 10n * AUSD]);
  await requesterToken.write.approve([escrow.address, 100n * AUSD]);
  await creatorAToken.write.approve([escrow.address, 10n * AUSD]);
  await creatorBToken.write.approve([escrow.address, 10n * AUSD]);

  return {
    publicClient,
    testClient,
    requester,
    creatorA,
    creatorB,
    platform,
    token,
    escrow,
    requesterEscrow,
    creatorAEscrow,
    creatorBEscrow,
    oracleEscrow,
  };
}

async function futureDeadline(publicClient, seconds = 3_600n) {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return block.timestamp + seconds + 1n;
}

async function createPhotoContest(ctx, budget = 20n * AUSD) {
  const deadline = await futureDeadline(ctx.publicClient);
  await ctx.requesterEscrow.write.createContest([
    0,
    budget,
    deadline,
    10,
    keccak256(toBytes(`brief-${deadline}`)),
  ]);
  return deadline;
}

async function testCancellation() {
  const ctx = await setup();
  await createPhotoContest(ctx);
  assert.equal(await ctx.token.read.balanceOf([ctx.escrow.address]), 20n * AUSD);
  await ctx.requesterEscrow.write.cancelBeforeFirstSubmission([1n]);
  assert.equal(await ctx.token.read.balanceOf([ctx.requester.account.address]), 100n * AUSD);
  assert.equal(await ctx.token.read.balanceOf([ctx.escrow.address]), 0n);
}

async function testWinnerSettlement() {
  const ctx = await setup();
  const deadline = await createPhotoContest(ctx);
  await ctx.creatorAEscrow.write.submitWork([1n, keccak256(toBytes("creator-a"))]);
  await ctx.creatorBEscrow.write.submitWork([1n, keccak256(toBytes("creator-b"))]);
  await ctx.oracleEscrow.write.recordEligibility([1n, 1, keccak256(toBytes("valid-a"))]);
  await ctx.oracleEscrow.write.recordEligibility([2n, 1, keccak256(toBytes("valid-b"))]);

  const current = (await ctx.publicClient.getBlock({ blockTag: "latest" })).timestamp;
  await ctx.testClient.increaseTime({ seconds: Number(deadline - current + 1n) });
  await ctx.testClient.mine({ blocks: 1 });
  await ctx.requesterEscrow.write.chooseWinner([1n, 1n]);

  assert.equal(await ctx.token.read.balanceOf([ctx.creatorA.account.address]), 27n * AUSD);
  assert.equal(await ctx.token.read.balanceOf([ctx.creatorB.account.address]), 11n * AUSD);
  assert.equal(await ctx.token.read.balanceOf([ctx.platform.account.address]), 2n * AUSD);
  assert.equal(await ctx.token.read.balanceOf([ctx.escrow.address]), 0n);
}

async function testTimeoutWithoutValidWork() {
  const ctx = await setup();
  const deadline = await createPhotoContest(ctx);
  await ctx.creatorAEscrow.write.submitWork([1n, keccak256(toBytes("checking"))]);

  const current = (await ctx.publicClient.getBlock({ blockTag: "latest" })).timestamp;
  await ctx.testClient.increaseTime({ seconds: Number(deadline + 48n * 60n * 60n - current + 1n) });
  await ctx.testClient.mine({ blocks: 1 });
  await ctx.requesterEscrow.write.settleAfterTimeout([1n]);

  assert.equal(await ctx.token.read.balanceOf([ctx.requester.account.address]), 98n * AUSD);
  assert.equal(await ctx.token.read.balanceOf([ctx.creatorA.account.address]), 10n * AUSD);
  assert.equal(await ctx.token.read.balanceOf([ctx.platform.account.address]), 2n * AUSD);
  assert.equal(await ctx.token.read.balanceOf([ctx.escrow.address]), 0n);
}

async function testReplacementLimitAndSingleBond() {
  const ctx = await setup();
  await createPhotoContest(ctx);
  await ctx.creatorAEscrow.write.submitWork([1n, keccak256(toBytes("v1"))]);
  const afterBond = await ctx.token.read.balanceOf([ctx.creatorA.account.address]);
  await ctx.creatorAEscrow.write.submitWork([1n, keccak256(toBytes("v2"))]);
  await ctx.creatorAEscrow.write.submitWork([1n, keccak256(toBytes("v3"))]);
  assert.equal(await ctx.token.read.balanceOf([ctx.creatorA.account.address]), afterBond);
  await assert.rejects(() =>
    ctx.creatorAEscrow.write.submitWork([1n, keccak256(toBytes("v4"))]),
  );
  const submission = await ctx.escrow.read.submissions([1n]);
  assert.equal(submission[3], 3);
}

const checks = [
  ["zero-submission cancellation returns all escrow", testCancellation],
  ["winner settlement pays 85/5/10 and returns bonds", testWinnerSettlement],
  ["timeout with no valid work refunds 90% and returns bonds", testTimeoutWithoutValidWork],
  ["two replacements reuse one bond and a fourth version reverts", testReplacementLimitAndSingleBond],
];

for (const [name, check] of checks) {
  await check();
  console.log(`PASS ${name}`);
}

console.log(`Contract checks passed: ${checks.length}/${checks.length}`);
