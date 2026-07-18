import assert from "node:assert/strict";
import test from "node:test";
import { detectFileFormat, inspectUploadedFile, PUBLIC_UPLOAD_MAX_BYTES, readVideoDurationSeconds } from "../worker/file-checks.js";
import { contestWindow, JUDGING_WINDOW_MS } from "../worker/timing.js";

const concat = (...parts) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
};

const u32 = (value) => new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
const text = (value) => new TextEncoder().encode(value);
const box = (type, payload) => concat(u32(payload.length + 8), text(type), payload);

function mp4(durationSeconds) {
  const mvhdPayload = new Uint8Array(20);
  mvhdPayload.set(u32(1_000), 12);
  mvhdPayload.set(u32(durationSeconds * 1_000), 16);
  const source = concat(box("ftyp", text("isom0000")), box("moov", box("mvhd", mvhdPayload)));
  const padded = new Uint8Array(1_024);
  padded.set(source);
  return padded;
}

test("server file checks inspect signatures, 4 MB, duplicates, attestation, and video duration", () => {
  const png = new Uint8Array(1_024);
  png.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  assert.equal(detectFileFormat(png), "png");
  assert.equal(inspectUploadedFile({ assetType: "Photo / Visual", bytes: png, ownershipAttested: true }).status, "VALID");
  assert.deepEqual(inspectUploadedFile({ assetType: "Photo / Visual", bytes: png, duplicate: true, ownershipAttested: true }).reasonCodes, ["DUPLICATE_CONTENT_HASH"]);
  assert.ok(inspectUploadedFile({ assetType: "Photo / Visual", bytes: new Uint8Array(PUBLIC_UPLOAD_MAX_BYTES + 1), ownershipAttested: true }).reasonCodes.includes("FILE_TOO_LARGE"));
  assert.ok(inspectUploadedFile({ assetType: "Photo / Visual", bytes: png }).reasonCodes.includes("OWNERSHIP_ATTESTATION_MISSING"));

  const thirtySeconds = mp4(30);
  assert.equal(readVideoDurationSeconds(thirtySeconds), 30);
  assert.equal(inspectUploadedFile({ assetType: "Short Video", bytes: thirtySeconds, ownershipAttested: true }).status, "VALID");
  assert.ok(inspectUploadedFile({ assetType: "Short Video", bytes: mp4(31), ownershipAttested: true }).reasonCodes.includes("VIDEO_DURATION_INVALID"));
});

test("early-cap judging uses the onchain Oracle block time instead of the later submission deadline", () => {
  const judgingStartedAt = "2026-07-02T00:00:00.000Z";
  const contest = {
    status: "OPEN",
    submission_deadline: "2026-07-10T00:00:00.000Z",
    judging_started_at: judgingStartedAt,
    valid_count: 10,
    valid_cap: 10,
  };
  const beforeTimeout = contestWindow(contest, Date.parse(judgingStartedAt) + JUDGING_WINDOW_MS - 1);
  assert.equal(beforeTimeout.judgingOpen, true);
  assert.equal(beforeTimeout.timeoutReady, false);
  const afterTimeout = contestWindow(contest, Date.parse(judgingStartedAt) + JUDGING_WINDOW_MS + 1);
  assert.equal(afterTimeout.judgingOpen, false);
  assert.equal(afterTimeout.timeoutReady, true);
  assert.equal(afterTimeout.judgingDeadlineAt, Date.parse("2026-07-04T00:00:00.000Z"));
});
