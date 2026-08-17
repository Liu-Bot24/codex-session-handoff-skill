#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SCHEMA_VERSION = 1;
const MIN_BASE64_CHARS = 4096;
const MAX_ATTESTATION_AGE_MS = 30_000;
const MAX_SESSION_META_BYTES = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLEANABLE_SOURCE_STATUSES = new Set(["idle", "notLoaded"]);
const DATA_IMAGE_RE = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,\s]+)*;base64,([^\s"'<>)}\],]+)/gi;
const MARKER_RE = /\[\[session-cleanup:duplicate-image sha256=([0-9a-f]{64}) bytes=([0-9]+)\]\]/gi;

class VerificationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VerificationError";
    this.details = details;
  }
}

function assert(condition, message, details = {}) {
  if (!condition) throw new VerificationError(message, details);
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJson(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    throw new VerificationError(`Cannot read JSON: ${target}`, { cause: error.message });
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function sessionFilenameMatchesTaskId(filename, taskId) {
  const normalized = filename.toLowerCase();
  const id = taskId.toLowerCase();
  return normalized === `${id}.jsonl`
    || (normalized.startsWith("rollout-") && normalized.endsWith(`-${id}.jsonl`));
}

async function readFirstJsonRecord(target) {
  let content = "";
  for await (const chunk of createReadStream(target, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
    content += chunk;
    const newline = content.indexOf("\n");
    if (newline >= 0) {
      content = content.slice(0, newline);
      break;
    }
    assert(Buffer.byteLength(content, "utf8") <= MAX_SESSION_META_BYTES,
      "Worker session metadata exceeds the safety limit", { path: target });
  }
  const firstLine = content.replace(/\r$/, "");
  assert(firstLine.length > 0, "Worker session transcript is empty", { path: target });
  try {
    return JSON.parse(firstLine);
  } catch (error) {
    throw new VerificationError("Worker session metadata is not valid JSON", {
      path: target,
      cause: error.message,
    });
  }
}

async function verifyWorkerIdentity(target, taskId) {
  assert(UUID_RE.test(taskId), "Worker task ID must be a UUID", { taskId });
  const resolved = await realpath(path.resolve(target));
  assert(sessionFilenameMatchesTaskId(path.basename(resolved), taskId),
    "Worker transcript filename does not match its task ID", { resolved, taskId });
  const firstRecord = await readFirstJsonRecord(resolved);
  assert(firstRecord?.type === "session_meta", "Worker transcript must start with session_meta", {
    path: resolved,
    actualType: firstRecord?.type ?? null,
  });
  const payload = firstRecord.payload;
  assert(payload && typeof payload === "object" && !Array.isArray(payload),
    "Worker session metadata payload is missing", { path: resolved });
  assert(payload.id === taskId, "Worker session metadata payload.id does not match its task ID", {
    path: resolved,
    taskId,
    payloadId: payload.id ?? null,
  });
  if (Object.prototype.hasOwnProperty.call(payload, "session_id")) {
    assert(payload.session_id === taskId,
      "Worker session metadata payload.session_id does not match its task ID", {
        path: resolved,
        taskId,
        payloadSessionId: payload.session_id ?? null,
      });
  }
  return resolved;
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.verify-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    await fsyncDirectory(path.dirname(target));
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function decodeBase64Strict(payload) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  const bare = payload.replace(/=+$/, "");
  if (bare.length % 4 === 1) return null;
  if (payload.includes("=") && payload.indexOf("=") < bare.length) return null;
  const normalized = bare + "=".repeat((4 - (bare.length % 4)) % 4);
  let bytes;
  try {
    bytes = Buffer.from(normalized, "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== bare) return null;
  return bytes;
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function normalizeString(text, state) {
  MARKER_RE.lastIndex = 0;
  let normalized = text.replace(MARKER_RE, (_whole, digest, byteText) => {
    const key = `${digest.toLowerCase()}:${Number(byteText)}`;
    increment(state.markers, key);
    return `[[verified-image:${key}]]`;
  });
  DATA_IMAGE_RE.lastIndex = 0;
  normalized = normalized.replace(DATA_IMAGE_RE, (whole, payload) => {
    if (payload.length < MIN_BASE64_CHARS) return whole;
    const bytes = decodeBase64Strict(payload);
    if (!bytes) return whole;
    const key = `${sha256Buffer(bytes)}:${bytes.length}`;
    increment(state.retained, key);
    return `[[verified-image:${key}]]`;
  });
  return normalized;
}

function normalizeJsonStrings(rawJson, state) {
  let output = "";
  let cursor = 0;
  while (cursor < rawJson.length) {
    if (rawJson[cursor] !== '"') {
      output += rawJson[cursor];
      cursor += 1;
      continue;
    }
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < rawJson.length) {
      const character = rawJson[cursor];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') break;
      cursor += 1;
    }
    assert(cursor < rawJson.length, "Malformed JSON string token during independent verification");
    const token = rawJson.slice(start, cursor + 1);
    cursor += 1;
    let lookahead = cursor;
    while (lookahead < rawJson.length && /\s/.test(rawJson[lookahead])) lookahead += 1;
    if (rawJson[lookahead] === ":") {
      output += token;
      continue;
    }
    const decoded = JSON.parse(token);
    const normalized = normalizeString(decoded, state);
    output += normalized === decoded ? token : JSON.stringify(normalized);
  }
  return output;
}

async function* jsonlLines(target) {
  let carry = "";
  for await (const chunk of createReadStream(target, { encoding: "utf8" })) {
    carry += chunk;
    while (true) {
      const index = carry.indexOf("\n");
      if (index < 0) break;
      const raw = carry.slice(0, index);
      carry = carry.slice(index + 1);
      yield raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    }
  }
  if (carry.length > 0) yield carry;
}

async function semanticScan(target) {
  const state = { retained: new Map(), markers: new Map() };
  const semanticHash = createHash("sha256");
  let records = 0;
  let lineNumber = 0;
  for await (const line of jsonlLines(target)) {
    lineNumber += 1;
    if (line.length === 0) continue;
    try {
      JSON.parse(line);
    } catch (error) {
      throw new VerificationError("Malformed JSONL during independent verification", {
        path: target,
        line: lineNumber,
        cause: error.message,
      });
    }
    records += 1;
    semanticHash.update(normalizeJsonStrings(line, state));
    semanticHash.update("\n");
  }
  return {
    records,
    semanticSha256: semanticHash.digest("hex"),
    retained: Object.fromEntries([...state.retained.entries()].sort()),
    markers: Object.fromEntries([...state.markers.entries()].sort()),
  };
}

function validateCounts(raw, cleaned) {
  const rawKeys = Object.keys(raw.retained).sort();
  const cleanedKeys = [...new Set([...Object.keys(cleaned.retained), ...Object.keys(cleaned.markers)])].sort();
  assert(JSON.stringify(rawKeys) === JSON.stringify(cleanedKeys),
    "Cleaned session does not contain exactly the original unique image set", { rawKeys, cleanedKeys });
  for (const key of rawKeys) {
    const rawCount = raw.retained[key] || 0;
    const retainedCount = cleaned.retained[key] || 0;
    const markerCount = cleaned.markers[key] || 0;
    assert(retainedCount === 1, "Each unique embedded image must retain exactly one complete payload", {
      key,
      retainedCount,
    });
    assert(markerCount === rawCount - 1, "Only later duplicate payloads may be replaced", {
      key,
      rawCount,
      markerCount,
    });
  }
}

async function validateAttestation(manifest, attestationPath) {
  const proof = await readJson(path.resolve(attestationPath));
  assert(proof.schemaVersion === SCHEMA_VERSION, "Unsupported state attestation version");
  assert(proof.transactionId === manifest.transactionId, "State attestation belongs to another transaction");
  assert(proof.sourceTaskId === manifest.source.taskId, "State attestation belongs to another source task");
  assert(CLEANABLE_SOURCE_STATUSES.has(proof.sourceStatus),
    "Independent verification requires authoritative idle or notLoaded status");
  assert(proof.sourceRealPath === manifest.source.realPath, "State attestation names another source transcript");
  assert(proof.checkerTaskId === proof.checkerSessionId && proof.checkerTaskId !== proof.sourceTaskId,
    "Verifier is not a distinct top-level task");
  assert(proof.checkerKind === "root" && proof.forkedFromId === null, "Verifier is a fork or subagent");
  const checkerRealPath = await verifyWorkerIdentity(proof.checkerTranscriptRealPath, proof.checkerTaskId);
  assert(checkerRealPath === proof.checkerTranscriptRealPath,
    "Verifier transcript identity changed after attestation", {
      expected: proof.checkerTranscriptRealPath,
      actual: checkerRealPath,
    });
  assert(checkerRealPath.toLowerCase() !== manifest.source.realPath.toLowerCase(),
    "Verifier and source transcript files are identical");
  const checkedAt = Date.parse(proof.checkedAt);
  const ageMs = Date.now() - checkedAt;
  assert(Number.isFinite(ageMs) && ageMs >= -5_000 && ageMs <= MAX_ATTESTATION_AGE_MS,
    "Verification state attestation is stale", { checkedAt: proof.checkedAt, ageMs });
  assert(checkedAt >= Date.parse(manifest.committedAt) - 5_000,
    "Verification state attestation predates the commit", {
      checkedAt: proof.checkedAt,
      committedAt: manifest.committedAt,
    });
  return proof;
}

async function fsyncFile(target) {
  const handle = await open(target, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function replaceFileAtomically(source, target, mode, beforeRename = null) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.replace-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    await copyFile(source, temporary);
    await chmod(temporary, mode).catch(() => {});
    await fsyncFile(temporary);
    if (beforeRename) await beforeRename();
    await rename(temporary, target);
    await fsyncDirectory(path.dirname(target));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function verifyRawBackup(manifest) {
  const rawSha256 = await sha256File(manifest.backup.rawPath);
  assert(rawSha256 === manifest.source.originalSha256, "Raw backup hash does not match the manifest", {
    expected: manifest.source.originalSha256,
    actual: rawSha256,
  });
  const sidecarText = (await readFile(manifest.backup.rawSha256Path, "utf8")).trim();
  assert(sidecarText === `${rawSha256}  ${path.basename(manifest.backup.rawPath)}`,
    "Raw backup SHA256 sidecar is invalid", { sidecarText });
  return rawSha256;
}

async function releaseLock(lockPath) {
  await unlink(lockPath).catch(() => {});
}

async function appendVerificationIndex(manifest, status) {
  const lockPath = path.join(path.dirname(manifest.lockPath), "index.lock");
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await appendFile(manifest.backup.indexPath, `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      transactionId: manifest.transactionId,
      status,
      at: new Date().toISOString(),
      manifestPath: manifest.backup.manifestPath,
      rawBackupPath: manifest.backup.rawPath,
    })}\n`, "utf8");
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function rollbackAfterFailure(manifest, reason, attestationPath) {
  await verifyRawBackup(manifest);
  await replaceFileAtomically(
    manifest.backup.rawPath,
    manifest.source.realPath,
    Number(manifest.source.fingerprint.mode),
    () => validateAttestation(manifest, attestationPath),
  );
  const restoredSha256 = await sha256File(manifest.source.realPath);
  assert(restoredSha256 === manifest.source.originalSha256, "Verification rollback did not restore the raw hash", {
    expected: manifest.source.originalSha256,
    actual: restoredSha256,
  });
  manifest.status = "rolled-back-after-verification-failure";
  manifest.verification = { at: new Date().toISOString(), error: reason, restoredSha256 };
  await writeJsonAtomic(manifest.backup.manifestPath, manifest);
  await appendVerificationIndex(manifest, manifest.status);
  await releaseLock(manifest.lockPath);
  return restoredSha256;
}

async function verify(manifestPath, attestationPath) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = await readJson(resolvedManifest);
  assert(manifest.schemaVersion === SCHEMA_VERSION, "Unsupported cleanup manifest version");
  assert(["commit-intent-recorded", "committed-awaiting-verification"].includes(manifest.status),
    "Transaction is not awaiting verification or interrupted-commit recovery", {
    status: manifest.status,
  });
  let stateValidated = false;
  try {
    if (manifest.status === "commit-intent-recorded") {
      assert(manifest.commitIntent, "Interrupted commit metadata is incomplete");
      assert(manifest.commitIntent.expectedOriginalSha256 === manifest.source.originalSha256,
        "Interrupted commit original hash does not match the manifest");
      assert(manifest.commitIntent.expectedCleanedSha256 === manifest.staging.cleanedSha256,
        "Interrupted commit cleaned hash does not match the manifest");
      assert(Number.isFinite(Date.parse(manifest.commitIntent.recordedAt)),
        "Interrupted commit timestamp is invalid");
      const interruptedSourceRealPath = await realpath(manifest.source.realPath);
      assert(interruptedSourceRealPath === manifest.source.realPath,
        "Source real path changed during interrupted commit recovery", {
          expected: manifest.source.realPath,
          actual: interruptedSourceRealPath,
        });
      const interruptedSourceSha256 = await sha256File(interruptedSourceRealPath);
      assert(interruptedSourceSha256 === manifest.staging.cleanedSha256,
        "Interrupted commit did not leave the verified cleaned content in the source", {
          expected: manifest.staging.cleanedSha256,
          actual: interruptedSourceSha256,
        });
      manifest.committedAt = manifest.commitIntent.recordedAt;
      manifest.committedSha256 = interruptedSourceSha256;
      manifest.commitAttestationPath = manifest.commitIntent.attestationPath;
      await validateAttestation(manifest, attestationPath);
      stateValidated = true;
      if (await pathExists(manifest.staging.cleanedPath)) {
        const stagedSha256 = await sha256File(manifest.staging.cleanedPath);
        assert(stagedSha256 === manifest.staging.cleanedSha256,
          "Interrupted commit staging file changed", {
            expected: manifest.staging.cleanedSha256,
            actual: stagedSha256,
          });
        await unlink(manifest.staging.cleanedPath);
      }
      const interruptedStagingEntries = await readdir(manifest.staging.root);
      assert(interruptedStagingEntries.length === 0,
        "Staging is not empty during interrupted commit recovery", {
          staging: manifest.staging.root,
          entries: interruptedStagingEntries,
        });
      manifest.status = "committed-awaiting-verification";
      manifest.commitIntent.recoveredAt = new Date().toISOString();
      manifest.commitIntent.recovery = "source-already-replaced";
      await writeJsonAtomic(resolvedManifest, manifest);
    } else {
      await validateAttestation(manifest, attestationPath);
      stateValidated = true;
    }
    const rawSha256 = await verifyRawBackup(manifest);
    const sourceRealPath = await realpath(manifest.source.realPath);
    assert(sourceRealPath === manifest.source.realPath, "Source real path changed after commit", {
      expected: manifest.source.realPath,
      actual: sourceRealPath,
    });
    const cleanedSha256 = await sha256File(sourceRealPath);
    assert(cleanedSha256 === manifest.committedSha256 && cleanedSha256 === manifest.staging.cleanedSha256,
      "Cleaned source hash does not match the committed manifest", {
        manifestSha256: manifest.committedSha256,
        stagingSha256: manifest.staging.cleanedSha256,
        actual: cleanedSha256,
      });
    const sourceInfo = await stat(sourceRealPath, { bigint: true });
    assert(sourceInfo.mode.toString() === manifest.source.fingerprint.mode,
      "Cleaned source permissions changed", {
        expectedMode: manifest.source.fingerprint.mode,
        actualMode: sourceInfo.mode.toString(),
      });
    const raw = await semanticScan(manifest.backup.rawPath);
    const cleaned = await semanticScan(sourceRealPath);
    assert(raw.records === cleaned.records, "JSONL record count changed", {
      rawRecords: raw.records,
      cleanedRecords: cleaned.records,
    });
    assert(raw.semanticSha256 === cleaned.semanticSha256,
      "Non-image session structure or content changed", {
        rawSemanticSha256: raw.semanticSha256,
        cleanedSemanticSha256: cleaned.semanticSha256,
      });
    validateCounts(raw, cleaned);
    const stagingEntries = await readdir(manifest.staging.root);
    assert(stagingEntries.length === 0, "Staging is not empty after cleanup", {
      staging: manifest.staging.root,
      entries: stagingEntries,
    });
    manifest.status = "verified";
    manifest.verifiedAt = new Date().toISOString();
    manifest.verifyAttestationPath = path.resolve(attestationPath);
    manifest.verification = {
      verifier: "verify_cleanup.mjs",
      processId: process.pid,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      rawSha256,
      cleanedSha256,
      rawSemanticSha256: raw.semanticSha256,
      cleanedSemanticSha256: cleaned.semanticSha256,
      uniqueImagesRetained: Object.keys(raw.retained).length,
      duplicatePayloadsReplaced: Object.values(cleaned.markers).reduce((sum, value) => sum + value, 0),
      stagingEmpty: true,
    };
    await writeJsonAtomic(resolvedManifest, manifest);
    await appendVerificationIndex(manifest, "verified");
    await releaseLock(manifest.lockPath);
    return {
      ok: true,
      command: "verify",
      status: "verified",
      source: sourceRealPath,
      backupRoot: manifest.backup.root,
      rawBackupPath: manifest.backup.rawPath,
      rawSha256Path: manifest.backup.rawSha256Path,
      manifestPath: resolvedManifest,
      indexPath: manifest.backup.indexPath,
      beforeBytes: Number(manifest.source.fingerprint.size),
      afterBytes: (await stat(sourceRealPath)).size,
      uniqueImagesRetained: manifest.verification.uniqueImagesRetained,
      duplicatePayloadsReplaced: manifest.verification.duplicatePayloadsReplaced,
    };
  } catch (error) {
    if (stateValidated) {
      try {
        const restoredSha256 = await rollbackAfterFailure(manifest, error.message, attestationPath);
        throw new VerificationError("Independent verification failed; the raw backup was automatically restored and verified", {
          verificationError: error.message,
          restoredSha256,
          rawBackupPath: manifest.backup.rawPath,
        });
      } catch (rollbackError) {
        if (rollbackError instanceof VerificationError && rollbackError.message.startsWith("Independent verification failed;")) {
          throw rollbackError;
        }
        manifest.status = "rollback-failed";
        manifest.verification = { at: new Date().toISOString(), error: error.message, rollbackError: rollbackError.message };
        await writeJsonAtomic(resolvedManifest, manifest).catch(() => {});
        throw new VerificationError("Independent verification and automatic rollback both failed", {
          verificationError: error.message,
          rollbackError: rollbackError.message,
          rawBackupPath: manifest.backup.rawPath,
        });
      }
    }
    throw error;
  }
}

async function main(argv) {
  assert(argv.length === 2, "Usage: node verify_cleanup.mjs <manifest> <post-commit-state-attestation>");
  return verify(argv[0], argv[1]);
}

main(process.argv.slice(2))
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, details: error.details || {} }, null, 2)}\n`);
    process.exitCode = 1;
  });
