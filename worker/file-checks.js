export const PUBLIC_UPLOAD_MAX_BYTES = 4_000_000;

const ascii = (bytes, offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
const startsWith = (bytes, signature) => signature.every((value, index) => bytes[index] === value);

export function detectFileFormat(bytes) {
  if (startsWith(bytes, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) return "png";
  if (startsWith(bytes, [0xff,0xd8,0xff])) return "jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (startsWith(bytes, [0x50,0x4b,0x03,0x04]) || startsWith(bytes, [0x50,0x4b,0x05,0x06]) || startsWith(bytes, [0x50,0x4b,0x07,0x08])) return "zip";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") return "mp4";
  if (startsWith(bytes, [0x1a,0x45,0xdf,0xa3])) return "webm";
  return null;
}

export function mimeTypeForFormat(format) {
  return ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp", zip: "application/zip", mp4: "video/mp4", webm: "video/webm" })[format] || "application/octet-stream";
}

function mp4DurationSeconds(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const box = (start, limit, target) => {
    let offset = start;
    while (offset + 8 <= limit) {
      let size = view.getUint32(offset, false);
      const type = ascii(bytes, offset + 4, 4);
      let header = 8;
      if (size === 1 && offset + 16 <= limit) {
        size = Number(view.getBigUint64(offset + 8, false));
        header = 16;
      } else if (size === 0) size = limit - offset;
      if (!Number.isFinite(size) || size < header || offset + size > limit) return null;
      if (type === target) return { start: offset + header, end: offset + size };
      offset += size;
    }
    return null;
  };
  const moov = box(0, bytes.length, "moov");
  if (!moov) return null;
  const mvhd = box(moov.start, moov.end, "mvhd");
  if (!mvhd || mvhd.start + 20 > mvhd.end) return null;
  const version = bytes[mvhd.start];
  const timescaleOffset = mvhd.start + (version === 1 ? 20 : 12);
  const durationOffset = timescaleOffset + 4;
  if (durationOffset + (version === 1 ? 8 : 4) > mvhd.end) return null;
  const timescale = view.getUint32(timescaleOffset, false);
  const duration = version === 1 ? Number(view.getBigUint64(durationOffset, false)) : view.getUint32(durationOffset, false);
  return timescale > 0 && Number.isFinite(duration) ? duration / timescale : null;
}

function findSequence(bytes, sequence) {
  outer: for (let index = 0; index <= bytes.length - sequence.length; index += 1) {
    for (let part = 0; part < sequence.length; part += 1) if (bytes[index + part] !== sequence[part]) continue outer;
    return index;
  }
  return -1;
}

function readVint(bytes, offset) {
  const first = bytes[offset];
  if (!first) return null;
  let length = 1, marker = 0x80;
  while (length <= 8 && (first & marker) === 0) { marker >>= 1; length += 1; }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = first & (marker - 1);
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index];
  return { length, value };
}

function webmElement(bytes, id) {
  const index = findSequence(bytes, id);
  if (index < 0) return null;
  const size = readVint(bytes, index + id.length);
  if (!size) return null;
  const start = index + id.length + size.length;
  return start + size.value <= bytes.length ? bytes.slice(start, start + size.value) : null;
}

function webmDurationSeconds(bytes) {
  const scaleBytes = webmElement(bytes, [0x2a,0xd7,0xb1]);
  const durationBytes = webmElement(bytes, [0x44,0x89]);
  if (!durationBytes || ![4,8].includes(durationBytes.length)) return null;
  let scale = 1_000_000;
  if (scaleBytes?.length) {
    scale = 0;
    for (const byte of scaleBytes) scale = scale * 256 + byte;
  }
  const view = new DataView(durationBytes.buffer, durationBytes.byteOffset, durationBytes.byteLength);
  const duration = durationBytes.length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
  return Number.isFinite(duration) && duration > 0 ? duration * scale / 1_000_000_000 : null;
}

export function readVideoDurationSeconds(bytes, format = detectFileFormat(bytes)) {
  if (format === "mp4") return mp4DurationSeconds(bytes);
  if (format === "webm") return webmDurationSeconds(bytes);
  return null;
}

export function inspectUploadedFile({ assetType, bytes, duplicate = false, ownershipAttested = false }) {
  const format = detectFileFormat(bytes);
  const allowed = assetType === "Photo / Visual" ? ["png","jpeg","webp"] : assetType === "Short Video" ? ["mp4","webm"] : ["zip"];
  const reasonCodes = [];
  if (bytes.byteLength > PUBLIC_UPLOAD_MAX_BYTES) reasonCodes.push("FILE_TOO_LARGE");
  if (bytes.byteLength < 1024) reasonCodes.push("FILE_TOO_SMALL");
  if (!allowed.includes(format)) reasonCodes.push("FORMAT_NOT_ALLOWED");
  if (duplicate) reasonCodes.push("DUPLICATE_CONTENT_HASH");
  if (!ownershipAttested) reasonCodes.push("OWNERSHIP_ATTESTATION_MISSING");
  const durationSeconds = assetType === "Short Video" && allowed.includes(format) ? readVideoDurationSeconds(bytes, format) : null;
  if (assetType === "Short Video" && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30)) reasonCodes.push("VIDEO_DURATION_INVALID");
  const status = reasonCodes.length === 0 ? "VALID" : "NEEDS_FIX";
  const message = status === "VALID"
    ? "File signature, 4 MB size limit, SHA-256 hash, duplicate screening, video duration when applicable, and creator rights attestation verified."
    : "The submitted file did not pass every objective file eligibility check.";
  return { status, reasonCodes, message, format, durationSeconds };
}
