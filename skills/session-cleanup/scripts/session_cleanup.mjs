#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const TOOL_VERSION = "1.5.0";
const SCHEMA_VERSION = 1;
const MIN_BASE64_CHARS = 4096;
const MAX_ATTESTATION_AGE_MS = 30_000;
const MAX_SESSION_META_BYTES = 1024 * 1024;
const CLEANABLE_SOURCE_STATUSES = new Set(["idle", "notLoaded"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATA_IMAGE_RE = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,\s]+)*;base64,([^\s"'<>)}\],]+)/gi;
const MARKER_PREFIX = "[[session-cleanup:duplicate-image";

class CleanupError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CleanupError";
    this.details = details;
  }
}

function codexHome() {
  const configured = process.env.CODEX_HOME;
  return path.resolve(configured && configured.trim() ? configured : path.join(os.homedir(), ".codex"));
}

function configPath() {
  return path.join(codexHome(), "session-cleanup", "config.json");
}

function defaultBackupRoot() {
  return path.join(codexHome(), "session-cleanup", "backups");
}

function defaultSessionsRoot() {
  return path.join(codexHome(), "sessions");
}

function isoNow() {
  return new Date().toISOString();
}

function beijingParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const yyyy = String(shifted.getUTCFullYear());
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const min = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  const ms = String(shifted.getUTCMilliseconds()).padStart(3, "0");
  return {
    year: yyyy,
    date: `${yyyy}-${mm}-${dd}`,
    stamp: `${yyyy}${mm}${dd}-${hh}${min}${ss}-${ms}-BJT`,
  };
}

function jsonOut(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message, details = {}) {
  if (!condition) throw new CleanupError(message, details);
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(data, "utf8");
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

async function readJson(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    throw new CleanupError(`Cannot read JSON: ${target}`, { cause: error.message });
  }
}

async function probeWritableDirectory(directory) {
  const resolved = path.resolve(directory);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  await chmod(resolved, 0o700).catch(() => {});
  const probe = path.join(resolved, `.session-cleanup-write-probe-${process.pid}-${randomBytes(5).toString("hex")}`);
  const expected = randomBytes(32);
  const handle = await open(probe, "wx", 0o600);
  try {
    await handle.write(expected);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const actual = await readFile(probe);
    assert(actual.equals(expected), "Backup directory write probe did not round-trip", { directory: resolved });
  } finally {
    await unlink(probe).catch(() => {});
  }
  return await realpath(resolved);
}

async function loadConfiguration({ requireExisting = true } = {}) {
  const target = configPath();
  if (!(await pathExists(target))) {
    if (requireExisting) {
      throw new CleanupError("Session Cleanup is not configured. Run the configure command first.", {
        configPath: target,
      });
    }
    return null;
  }
  const config = await readJson(target);
  assert(config.schemaVersion === SCHEMA_VERSION, "Unsupported Session Cleanup configuration version", {
    configPath: target,
  });
  assert(typeof config.backupRoot === "string" && path.isAbsolute(config.backupRoot), "Configured backup root must be absolute", {
    configPath: target,
  });
  return config;
}

async function configure(requestedRoot) {
  const previous = await loadConfiguration({ requireExisting: false });
  const candidate = requestedRoot
    ? path.resolve(requestedRoot)
    : previous?.backupRoot || defaultBackupRoot();
  let verifiedRoot;
  try {
    verifiedRoot = await probeWritableDirectory(candidate);
  } catch (error) {
    throw new CleanupError("Backup directory is unavailable; no fallback was selected", {
      requestedBackupRoot: candidate,
      configPath: configPath(),
      cause: error.message,
      userDecisionRequired: ["use a temporary location once", "replace the saved default location"],
    });
  }
  const now = isoNow();
  const config = {
    schemaVersion: SCHEMA_VERSION,
    backupRoot: verifiedRoot,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
  await writeJsonAtomic(configPath(), config);
  const installAssistantMessage = [
    "Session Handoff 和 Session Cleanup 已安装成功。",
    `Session Cleanup 当前默认备份位置：${verifiedRoot}`,
    "该目录已经创建并通过读写验证。你需要修改默认备份位置吗？",
  ].join("\n");
  return {
    command: "configure",
    configPath: configPath(),
    backupRoot: verifiedRoot,
    directoryVerified: true,
    previousBackupRoot: previous?.backupRoot || null,
    installAssistantMessage,
    configurationAssistantMessage: `Session Cleanup 默认备份位置已设置为：${verifiedRoot}`,
  };
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function fingerprint(target, includeHash = false) {
  const resolved = await realpath(target);
  const info = await stat(resolved, { bigint: true });
  assert(info.isFile(), "Session target is not a file", { path: resolved });
  const result = {
    realPath: resolved,
    device: info.dev.toString(),
    inode: info.ino.toString(),
    mode: info.mode.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
  };
  if (includeHash) result.sha256 = await sha256File(resolved);
  return result;
}

function sessionFilenameMatchesTaskId(filename, sourceTaskId) {
  const normalized = filename.toLowerCase();
  const id = sourceTaskId.toLowerCase();
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
      "Session metadata record exceeds the safety limit", { path: target, maxBytes: MAX_SESSION_META_BYTES });
  }
  const firstLine = content.replace(/\r$/, "");
  assert(firstLine.length > 0, "Session transcript is empty", { path: target });
  assert(Buffer.byteLength(firstLine, "utf8") <= MAX_SESSION_META_BYTES,
    "Session metadata record exceeds the safety limit", { path: target, maxBytes: MAX_SESSION_META_BYTES });
  try {
    return JSON.parse(firstLine);
  } catch (error) {
    throw new CleanupError("Session metadata record is not valid JSON", { path: target, cause: error.message });
  }
}

async function verifySessionIdentity(target, sourceTaskId) {
  const firstRecord = await readFirstJsonRecord(target);
  assert(firstRecord?.type === "session_meta", "Session transcript must start with a session_meta record", {
    path: target,
    actualType: firstRecord?.type ?? null,
  });
  const payload = firstRecord.payload;
  assert(payload && typeof payload === "object" && !Array.isArray(payload),
    "Session metadata payload is missing", { path: target });
  assert(payload.id === sourceTaskId,
    "Session metadata payload.id does not match the authoritative source task ID", {
      path: target,
      sourceTaskId,
      payloadId: payload.id ?? null,
    });
  const sessionIdPresent = Object.prototype.hasOwnProperty.call(payload, "session_id");
  if (sessionIdPresent) {
    assert(typeof payload.session_id === "string" && payload.session_id.length > 0
      && payload.session_id === sourceTaskId,
    "Present session metadata payload.session_id must match the authoritative source task ID", {
      path: target,
      sourceTaskId,
      payloadSessionId: payload.session_id ?? null,
    });
  }
  return {
    type: firstRecord.type,
    id: payload.id,
    sessionId: sessionIdPresent ? payload.session_id : null,
    sessionIdPresent,
    format: sessionIdPresent ? "current-dual-id" : "legacy-id-only",
    requiresExternalTaskConfirmation: !sessionIdPresent,
  };
}

function sameFingerprint(left, right, includeHash = false) {
  const keys = ["realPath", "device", "inode", "mode", "size", "mtimeNs"];
  if (includeHash) keys.push("sha256");
  return keys.every((key) => left[key] === right[key]);
}

async function resolveSessionTarget(inputPath, sourceTaskId = null) {
  const resolvedInput = path.resolve(inputPath);
  assert(path.extname(resolvedInput).toLowerCase() === ".jsonl", "Session target must be a .jsonl file", {
    path: resolvedInput,
  });
  if (sourceTaskId !== null) {
    assert(UUID_RE.test(sourceTaskId), "Source task ID must be a UUID", { sourceTaskId });
    assert(sessionFilenameMatchesTaskId(path.basename(resolvedInput), sourceTaskId),
      "Session filename must be the task ID or a Codex rollout filename ending in the task ID", {
        sourceTaskId,
        sessionPath: resolvedInput,
      });
  }
  const target = await fingerprint(resolvedInput);
  if (sourceTaskId !== null) await verifySessionIdentity(target.realPath, sourceTaskId);
  return target.realPath;
}

async function findSessionCandidates(directory, sourceTaskId, matches) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await findSessionCandidates(candidate, sourceTaskId, matches);
    } else if (entry.isFile() && sessionFilenameMatchesTaskId(entry.name, sourceTaskId)) {
      matches.push(candidate);
    }
  }
}

async function resolveSessionById(sourceTaskId, requestedSessionsRoot = null) {
  assert(UUID_RE.test(sourceTaskId), "Source task ID must be a UUID", { sourceTaskId });
  const sessionsRoot = path.resolve(requestedSessionsRoot || defaultSessionsRoot());
  const sessionsRootRealPath = await realpath(sessionsRoot).catch((error) => {
    throw new CleanupError("Codex sessions root is unavailable", { sessionsRoot, cause: error.message });
  });
  const rootInfo = await stat(sessionsRootRealPath);
  assert(rootInfo.isDirectory(), "Codex sessions root is not a directory", { sessionsRoot: sessionsRootRealPath });

  const matches = [];
  await findSessionCandidates(sessionsRootRealPath, sourceTaskId, matches);
  matches.sort((left, right) => left.localeCompare(right));
  assert(matches.length === 1, "Session ID must resolve to exactly one transcript", {
    sourceTaskId,
    sessionsRoot: sessionsRootRealPath,
    matchCount: matches.length,
    matches,
  });

  const sessionPath = await resolveSessionTarget(matches[0], sourceTaskId);
  const relative = path.relative(sessionsRootRealPath, sessionPath);
  assert(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Resolved session transcript escapes the Codex sessions root", {
      sessionsRoot: sessionsRootRealPath,
      sessionPath,
    });
  const identity = await verifySessionIdentity(sessionPath, sourceTaskId);
  return {
    command: "resolve",
    sourceTaskId,
    sessionsRoot: sessionsRootRealPath,
    sessionPath,
    filename: path.basename(sessionPath),
    identity,
  };
}

function decodeBase64Strict(payload) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  const firstPadding = payload.indexOf("=");
  if (firstPadding >= 0 && firstPadding < payload.length - (payload.endsWith("==") ? 2 : 1)) return null;
  const bare = payload.replace(/=+$/, "");
  if (bare.length % 4 === 1) return null;
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

function freshSummary() {
  return {
    jsonRecords: 0,
    invalidJsonRecords: 0,
    validLongImageOccurrences: 0,
    uniqueLongImages: 0,
    duplicateLongImages: 0,
    retainedLongImages: 0,
    replacedDuplicateImages: 0,
    shortDataImageExamples: 0,
    invalidLongDataImages: 0,
    decodedImageBytes: 0,
    compactedRecords: 0,
    largestCompactedRecordBytes: 0,
  };
}

function containsCompacted(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (typeof value.type === "string" && value.type.toLowerCase().includes("compact")) return true;
  if (Object.hasOwn(value, "compacted") || Object.hasOwn(value, "replacement_history")) return true;
  if (Array.isArray(value)) return value.some((item) => containsCompacted(item, seen));
  return Object.values(value).some((item) => containsCompacted(item, seen));
}

function replaceDataImages(text, state, mutate) {
  DATA_IMAGE_RE.lastIndex = 0;
  return text.replace(DATA_IMAGE_RE, (whole, payload) => {
    if (payload.length < MIN_BASE64_CHARS) {
      state.summary.shortDataImageExamples += 1;
      return whole;
    }
    const bytes = decodeBase64Strict(payload);
    if (!bytes) {
      state.summary.invalidLongDataImages += 1;
      state.invalidCandidates.push(sha256Buffer(Buffer.from(whole, "utf8")));
      return whole;
    }
    const digest = sha256Buffer(bytes);
    const key = `${digest}:${bytes.length}`;
    const count = (state.seen.get(key) || 0) + 1;
    state.seen.set(key, count);
    state.summary.validLongImageOccurrences += 1;
    state.summary.decodedImageBytes += bytes.length;
    if (count === 1) {
      state.summary.uniqueLongImages += 1;
      state.summary.retainedLongImages += 1;
      return whole;
    }
    state.summary.duplicateLongImages += 1;
    if (!mutate) return whole;
    state.summary.replacedDuplicateImages += 1;
    return `${MARKER_PREFIX} sha256=${digest} bytes=${bytes.length}]]`;
  });
}

function transformJsonStrings(rawJson, state, mutate) {
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
    assert(cursor < rawJson.length, "Malformed JSON string token during cleanup");
    const token = rawJson.slice(start, cursor + 1);
    cursor += 1;
    let lookahead = cursor;
    while (lookahead < rawJson.length && /\s/.test(rawJson[lookahead])) lookahead += 1;
    if (rawJson[lookahead] === ":") {
      output += token;
      continue;
    }
    const decoded = JSON.parse(token);
    const replaced = replaceDataImages(decoded, state, mutate);
    output += replaced === decoded ? token : JSON.stringify(replaced);
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
      if (raw.endsWith("\r")) yield { text: raw.slice(0, -1), eol: "\r\n" };
      else yield { text: raw, eol: "\n" };
    }
  }
  if (carry.length > 0) yield { text: carry, eol: "" };
}

async function scanOrTransform(input, output = null) {
  const state = { seen: new Map(), invalidCandidates: [], summary: freshSummary() };
  const outputHandle = output ? await open(output, "wx", 0o600) : null;
  let lineNumber = 0;
  try {
    for await (const line of jsonlLines(input)) {
      lineNumber += 1;
      if (line.text.length === 0) {
        if (outputHandle) await outputHandle.write(line.eol);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line.text);
      } catch (error) {
        state.summary.invalidJsonRecords += 1;
        throw new CleanupError("Malformed JSONL; cleanup fails closed", {
          path: input,
          line: lineNumber,
          cause: error.message,
        });
      }
      state.summary.jsonRecords += 1;
      if (containsCompacted(parsed)) {
        const bytes = Buffer.byteLength(line.text, "utf8");
        state.summary.compactedRecords += 1;
        state.summary.largestCompactedRecordBytes = Math.max(state.summary.largestCompactedRecordBytes, bytes);
      }
      const next = transformJsonStrings(line.text, state, Boolean(outputHandle));
      if (outputHandle) {
        await outputHandle.write(next + line.eol);
      }
    }
    if (outputHandle) await outputHandle.sync();
  } finally {
    if (outputHandle) await outputHandle.close();
  }
  return {
    summary: state.summary,
    imageKeys: [...state.seen.keys()].sort(),
    invalidCandidateDigests: state.invalidCandidates.sort(),
  };
}

async function inspect(sessionPath) {
  const source = await resolveSessionTarget(sessionPath);
  const before = await fingerprint(source, true);
  const report = await scanOrTransform(source);
  const after = await fingerprint(source, true);
  assert(sameFingerprint(before, after, true), "Session changed during inspection; report discarded", {
    before,
    after,
  });
  return {
    command: "inspect",
    source,
    bytes: Number(before.size),
    sha256: before.sha256,
    ...report,
  };
}

async function copyAndHash(source, destination, mode) {
  const hash = createHash("sha256");
  const handle = await open(destination, "wx", mode);
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(source)) {
      hash.update(chunk);
      bytes += chunk.length;
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function ensureBackupLayout(backupRoot) {
  const root = await probeWritableDirectory(backupRoot);
  const parts = beijingParts();
  const layout = {
    root,
    raw: path.join(root, "raw", parts.year, parts.date),
    manifests: path.join(root, "manifests", parts.year, parts.date),
    staging: path.join(root, "staging"),
    locks: path.join(root, "locks"),
    index: path.join(root, "index.jsonl"),
  };
  await Promise.all([
    mkdir(layout.raw, { recursive: true }),
    mkdir(layout.manifests, { recursive: true }),
    mkdir(layout.staging, { recursive: true }),
    mkdir(layout.locks, { recursive: true }),
  ]);
  return layout;
}

async function assertStagingEmpty(staging) {
  const entries = await readdir(staging);
  assert(entries.length === 0, "Staging is not empty; resolve the earlier transaction before continuing", {
    staging,
    entries,
  });
}

async function acquireSourceLock(layout, sourceRealPath, transactionId) {
  const key = sha256Buffer(Buffer.from(sourceRealPath.toLowerCase(), "utf8"));
  const lockPath = path.join(layout.locks, `source-${key}.lock.json`);
  try {
    await writeFile(lockPath, `${JSON.stringify({ transactionId, sourceRealPath, createdAt: isoNow() }, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new CleanupError("Another Session Cleanup transaction owns this source", {
      sourceRealPath,
      lockPath,
      cause: error.message,
    });
  }
  return lockPath;
}

async function appendIndex(layout, row) {
  const lockPath = path.join(layout.locks, "index.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    throw new CleanupError("Backup index is locked by another transaction", {
      lockPath,
      cause: error.message,
    });
  }
  try {
    await appendFile(layout.index, `${JSON.stringify(row)}\n`, "utf8");
    const indexHandle = await open(layout.index, "r+");
    try {
      await indexHandle.sync();
    } finally {
      await indexHandle.close();
    }
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function prepare(sessionPath, sourceTaskId, oneTimeBackupRoot = null) {
  const config = await loadConfiguration();
  const source = await resolveSessionTarget(sessionPath, sourceTaskId);
  const sourceIdentity = await verifySessionIdentity(source, sourceTaskId);
  if (oneTimeBackupRoot !== null) {
    assert(path.isAbsolute(oneTimeBackupRoot), "One-time backup root must be an absolute path", {
      oneTimeBackupRoot,
    });
  }
  const layout = await ensureBackupLayout(oneTimeBackupRoot || config.backupRoot);
  await assertStagingEmpty(layout.staging);
  const time = beijingParts();
  const transactionId = `${sourceTaskId}__${time.stamp}__${randomBytes(4).toString("hex")}`;
  const rawPath = path.join(layout.raw, `session__${sourceTaskId}__pre-cleanup-backup__${time.stamp}.jsonl`);
  const rawSha256Path = `${rawPath}.sha256`;
  const cleanedPath = path.join(layout.staging, `${transactionId}.cleaned.jsonl`);
  const manifestPath = path.join(layout.manifests, `manifest__${sourceTaskId}__cleanup__${time.stamp}.json`);
  const lockPath = await acquireSourceLock(layout, source, transactionId);
  let manifest = null;
  try {
    const sourceBefore = await fingerprint(source);
    const sourceInfo = await stat(source);
    const backup = await copyAndHash(source, rawPath, 0o600);
    const sourceAfterBackup = await fingerprint(source);
    assert(sameFingerprint(sourceBefore, sourceAfterBackup), "Source changed while the raw backup was created", {
      sourceBefore,
      sourceAfterBackup,
      rawPath,
    });
    assert(backup.bytes === Number(sourceBefore.size), "Raw backup size does not match the source snapshot", {
      sourceBytes: sourceBefore.size,
      backupBytes: backup.bytes,
    });
    await writeFile(rawSha256Path, `${backup.sha256}  ${path.basename(rawPath)}\n`, { flag: "wx", mode: 0o600 });
    const backedUpFingerprint = { ...sourceAfterBackup, sha256: backup.sha256 };
    manifest = {
      schemaVersion: SCHEMA_VERSION,
      transactionId,
      status: "backed-up-preparing",
      createdAt: isoNow(),
      source: {
        taskId: sourceTaskId,
        path: path.resolve(sessionPath),
        realPath: source,
        identity: sourceIdentity,
        fingerprint: backedUpFingerprint,
        originalSha256: backup.sha256,
      },
      backup: {
        root: layout.root,
        mode: oneTimeBackupRoot ? "one-time" : "saved-default",
        rawPath,
        rawSha256Path,
        manifestPath,
        indexPath: layout.index,
      },
      staging: {
        root: layout.staging,
        cleanedPath,
        cleanedSha256: null,
      },
      lockPath,
      cleaner: {
        name: "session-cleanup",
        version: TOOL_VERSION,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        minBase64Chars: MIN_BASE64_CHARS,
        policy: "retain-first-unique-image-replace-later-duplicates",
      },
      summary: null,
    };
    await writeJsonAtomic(manifestPath, manifest);
    await appendIndex(layout, {
      schemaVersion: SCHEMA_VERSION,
      transactionId,
      status: manifest.status,
      createdAt: manifest.createdAt,
      sourceTaskId,
      sourcePath: source,
      rawBackupPath: rawPath,
      rawSha256: backup.sha256,
      manifestPath,
    });
    const before = await scanOrTransform(rawPath, cleanedPath);
    await chmod(cleanedPath, sourceInfo.mode).catch(() => {});
    const cleanedSha256 = await sha256File(cleanedPath);
    const after = await scanOrTransform(cleanedPath);
    const sourceAfterPrepare = await fingerprint(source, true);
    assert(sourceAfterPrepare.sha256 === backup.sha256 && sameFingerprint(sourceBefore, sourceAfterPrepare),
      "Source changed while the cleaned staging copy was prepared", {
        sourceBefore,
        sourceAfterPrepare,
      });
    manifest.status = "prepared";
    manifest.preparedAt = isoNow();
    manifest.source.fingerprint = sourceAfterPrepare;
    manifest.staging.cleanedSha256 = cleanedSha256;
    manifest.summary = {
      before: before.summary,
      after: after.summary,
      imageKeysBefore: before.imageKeys,
      imageKeysAfter: after.imageKeys,
      invalidCandidateDigestsBefore: before.invalidCandidateDigests,
      invalidCandidateDigestsAfter: after.invalidCandidateDigests,
    };
    await writeJsonAtomic(manifestPath, manifest);
    await appendIndex(layout, {
      schemaVersion: SCHEMA_VERSION,
      transactionId,
      status: "prepared",
      createdAt: manifest.createdAt,
      sourceTaskId,
      sourcePath: source,
      rawBackupPath: rawPath,
      rawSha256: backup.sha256,
      manifestPath,
    });
    return {
      command: "prepare",
      transactionId,
      manifestPath,
      source,
      sourceBytes: Number(sourceBefore.size),
      backupRoot: layout.root,
      backupRootMode: manifest.backup.mode,
      rawBackupPath: rawPath,
      rawSha256Path,
      rawSha256: backup.sha256,
      cleanedStagingPath: cleanedPath,
      cleanedSha256,
      summary: manifest.summary,
      next: "Obtain a fresh authoritative idle or notLoaded state check, create an attestation, then commit.",
    };
  } catch (error) {
    await unlink(cleanedPath).catch(() => {});
    if (manifest) {
      manifest.status = "aborted-during-prepare";
      manifest.error = error.message;
      manifest.abortedAt = isoNow();
      await writeJsonAtomic(manifestPath, manifest).catch(() => {});
      await appendIndex(layout, {
        schemaVersion: SCHEMA_VERSION,
        transactionId,
        status: manifest.status,
        at: manifest.abortedAt,
        manifestPath,
        rawBackupPath: manifest.backup.rawPath,
      }).catch(() => {});
    }
    await unlink(lockPath).catch(() => {});
    throw error;
  }
}

async function createAttestation(manifestPath, sourceStatus, checkerTaskId, checkerSessionId, checkerKind, checkerTranscriptPath, forkedFromId = "none") {
  const manifest = await readJson(path.resolve(manifestPath));
  assert(manifest.schemaVersion === SCHEMA_VERSION, "Unsupported manifest version");
  assert([
    "prepared",
    "commit-intent-recorded",
    "committed-awaiting-verification",
    "verification-failed",
    "rollback-failed",
  ].includes(manifest.status),
  "Attestation is not valid for this transaction state", { status: manifest.status });
  assert(CLEANABLE_SOURCE_STATUSES.has(sourceStatus), "Source task must be authoritatively idle or notLoaded", {
    sourceStatus,
  });
  assert(UUID_RE.test(checkerTaskId) && UUID_RE.test(checkerSessionId), "Checker task and session IDs must be UUIDs");
  assert(checkerTaskId === checkerSessionId, "Cleanup worker must be a top-level root task", {
    checkerTaskId,
    checkerSessionId,
  });
  assert(checkerTaskId !== manifest.source.taskId, "Cleanup worker must differ from the source task");
  assert(checkerKind === "root", "Cleanup worker kind must be root", { checkerKind });
  assert(forkedFromId === "none", "Forked and subagent tasks cannot clean their source", { forkedFromId });
  const checkerRealPath = await resolveSessionTarget(checkerTranscriptPath, checkerTaskId);
  assert(checkerRealPath.toLowerCase() !== manifest.source.realPath.toLowerCase(),
    "Cleanup worker and source must have distinct transcript files", {
      checkerRealPath,
      sourceRealPath: manifest.source.realPath,
    });
  const checkedAt = isoNow();
  const outputPath = `${path.resolve(manifestPath)}.state-${Date.now()}.json`;
  const proof = {
    schemaVersion: SCHEMA_VERSION,
    transactionId: manifest.transactionId,
    sourceTaskId: manifest.source.taskId,
    sourceStatus,
    sourceRealPath: manifest.source.realPath,
    checkerTaskId,
    checkerSessionId,
    checkerKind,
    checkerTranscriptRealPath: checkerRealPath,
    forkedFromId: null,
    checkedAt,
  };
  await writeJsonAtomic(outputPath, proof);
  return { command: "attest", attestationPath: outputPath, ...proof };
}

async function validateAttestation(manifest, attestationPath) {
  const proof = await readJson(path.resolve(attestationPath));
  assert(proof.schemaVersion === SCHEMA_VERSION, "Unsupported state attestation version");
  assert(proof.transactionId === manifest.transactionId, "State attestation belongs to another transaction");
  assert(proof.sourceTaskId === manifest.source.taskId, "State attestation belongs to another source task");
  assert(CLEANABLE_SOURCE_STATUSES.has(proof.sourceStatus), "Source task is not authoritatively idle or notLoaded");
  assert(proof.sourceRealPath === manifest.source.realPath, "State attestation names another source transcript");
  assert(proof.checkerTaskId === proof.checkerSessionId, "Checker is not a top-level root task");
  assert(proof.checkerTaskId !== proof.sourceTaskId, "Checker and source task IDs are identical");
  assert(proof.checkerKind === "root" && proof.forkedFromId === null, "Checker is a fork or subagent");
  const checkerRealPath = await resolveSessionTarget(proof.checkerTranscriptRealPath, proof.checkerTaskId);
  assert(checkerRealPath === proof.checkerTranscriptRealPath,
    "Checker transcript identity changed after attestation", {
      expected: proof.checkerTranscriptRealPath,
      actual: checkerRealPath,
    });
  assert(proof.checkerTranscriptRealPath.toLowerCase() !== proof.sourceRealPath.toLowerCase(),
    "Checker and source transcript paths are identical");
  const ageMs = Date.now() - Date.parse(proof.checkedAt);
  assert(Number.isFinite(ageMs) && ageMs >= -5_000 && ageMs <= MAX_ATTESTATION_AGE_MS,
    "State attestation is stale; check source status again", { checkedAt: proof.checkedAt, ageMs });
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
  const sidecar = (await readFile(manifest.backup.rawSha256Path, "utf8")).trim();
  assert(sidecar === `${rawSha256}  ${path.basename(manifest.backup.rawPath)}`,
    "Raw backup SHA256 sidecar is invalid", { sidecar });
  return rawSha256;
}

async function restoreRaw(manifest, reason, beforeRename = null) {
  await verifyRawBackup(manifest);
  await replaceFileAtomically(
    manifest.backup.rawPath,
    manifest.source.realPath,
    Number(manifest.source.fingerprint.mode),
    beforeRename,
  );
  const restoredSha = await sha256File(manifest.source.realPath);
  assert(restoredSha === manifest.source.originalSha256, "Automatic rollback failed hash verification", {
    expected: manifest.source.originalSha256,
    actual: restoredSha,
  });
  manifest.status = "rolled-back";
  manifest.rollback = { at: isoNow(), reason, restoredSha256: restoredSha };
  await unlink(manifest.staging.cleanedPath).catch(() => {});
  await writeJsonAtomic(manifest.backup.manifestPath, manifest);
  await unlink(manifest.lockPath).catch(() => {});
}

async function reconcileCommitIntent(manifest, manifestPath, attestationPath) {
  assert(manifest.status === "commit-intent-recorded" && manifest.commitIntent,
    "Interrupted commit metadata is incomplete", { status: manifest.status });
  assert(manifest.commitIntent.expectedOriginalSha256 === manifest.source.originalSha256,
    "Interrupted commit original hash does not match the manifest");
  assert(manifest.commitIntent.expectedCleanedSha256 === manifest.staging.cleanedSha256,
    "Interrupted commit cleaned hash does not match the manifest");

  const sourceSha256 = await sha256File(manifest.source.realPath);
  if (sourceSha256 === manifest.staging.cleanedSha256) {
    const sourceRealPath = await realpath(manifest.source.realPath);
    assert(sourceRealPath === manifest.source.realPath,
      "Source real path changed during interrupted commit recovery", {
        expected: manifest.source.realPath,
        actual: sourceRealPath,
      });
    await validateAttestation(manifest, attestationPath);
    if (await pathExists(manifest.staging.cleanedPath)) {
      const stagedSha256 = await sha256File(manifest.staging.cleanedPath);
      assert(stagedSha256 === manifest.staging.cleanedSha256,
        "Interrupted commit staging file changed", {
          expected: manifest.staging.cleanedSha256,
          actual: stagedSha256,
        });
      await unlink(manifest.staging.cleanedPath);
    }
    await assertStagingEmpty(manifest.staging.root);
    manifest.status = "committed-awaiting-verification";
    manifest.committedAt = manifest.commitIntent.recordedAt;
    manifest.committedSha256 = sourceSha256;
    manifest.commitAttestationPath = manifest.commitIntent.attestationPath;
    manifest.commitIntent.recoveredAt = isoNow();
    manifest.commitIntent.recovery = "source-already-replaced";
    await writeJsonAtomic(manifestPath, manifest);
    return "committed";
  }

  if (sourceSha256 === manifest.source.originalSha256) {
    const sourceNow = await fingerprint(manifest.source.realPath, true);
    assert(sameFingerprint(sourceNow, manifest.source.fingerprint, true),
      "Interrupted commit source changed before replacement", {
        expected: manifest.source.fingerprint,
        actual: sourceNow,
      });
    manifest.commitRecoveries = [...(manifest.commitRecoveries || []), {
      at: isoNow(),
      outcome: "source-not-replaced",
      intent: manifest.commitIntent,
    }];
    delete manifest.commitIntent;
    manifest.status = "prepared";
    await writeJsonAtomic(manifestPath, manifest);
    return "prepared";
  }

  throw new CleanupError("Interrupted commit source matches neither original nor cleaned content", {
    sourceSha256,
    originalSha256: manifest.source.originalSha256,
    cleanedSha256: manifest.staging.cleanedSha256,
    rawBackupPath: manifest.backup.rawPath,
  });
}

async function commit(manifestPath, attestationPath) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = await readJson(resolvedManifestPath);
  assert(manifest.schemaVersion === SCHEMA_VERSION && ["prepared", "commit-intent-recorded"].includes(manifest.status),
    "Only a prepared or interrupted commit can be committed", { status: manifest.status });
  if (manifest.status === "commit-intent-recorded") {
    const recovered = await reconcileCommitIntent(manifest, resolvedManifestPath, attestationPath);
    if (recovered === "committed") {
      return {
        command: "commit",
        status: manifest.status,
        manifestPath: resolvedManifestPath,
        source: manifest.source.realPath,
        committedSha256: manifest.committedSha256,
        stagingEmpty: true,
        next: "Check source status again, create a new idle or notLoaded attestation, and run verify_cleanup.mjs in a new Node process.",
      };
    }
  }
  assert(await pathExists(manifest.lockPath), "Transaction source lock is missing", { lockPath: manifest.lockPath });
  const lock = await readJson(manifest.lockPath);
  assert(lock.transactionId === manifest.transactionId, "Transaction source lock belongs to another transaction");
  const sourceNow = await fingerprint(manifest.source.realPath, true);
  assert(sameFingerprint(sourceNow, manifest.source.fingerprint, true),
    "Source size, mtime, identity, path, or SHA256 changed; commit aborted", {
      expected: manifest.source.fingerprint,
      actual: sourceNow,
    });
  const stagedSha = await sha256File(manifest.staging.cleanedPath);
  assert(stagedSha === manifest.staging.cleanedSha256, "Cleaned staging file changed; commit aborted", {
    expected: manifest.staging.cleanedSha256,
    actual: stagedSha,
  });
  manifest.status = "commit-intent-recorded";
  manifest.commitIntent = {
    recordedAt: isoNow(),
    attestationPath: path.resolve(attestationPath),
    expectedOriginalSha256: manifest.source.originalSha256,
    expectedCleanedSha256: manifest.staging.cleanedSha256,
  };
  await writeJsonAtomic(resolvedManifestPath, manifest);
  let sourceReplaced = false;
  try {
    await replaceFileAtomically(
      manifest.staging.cleanedPath,
      manifest.source.realPath,
      Number(manifest.source.fingerprint.mode),
      async () => {
        await validateAttestation(manifest, attestationPath);
        const sourceImmediatelyBeforeWrite = await fingerprint(manifest.source.realPath);
        assert(sameFingerprint(sourceImmediatelyBeforeWrite, manifest.source.fingerprint),
          "Source identity, size, or mtime changed immediately before commit", {
            expected: manifest.source.fingerprint,
            actual: sourceImmediatelyBeforeWrite,
          });
      },
    );
    sourceReplaced = true;
    const committedSha = await sha256File(manifest.source.realPath);
    assert(committedSha === manifest.staging.cleanedSha256, "Committed source hash does not match staging", {
      expected: manifest.staging.cleanedSha256,
      actual: committedSha,
    });
    await unlink(manifest.staging.cleanedPath);
    await assertStagingEmpty(manifest.staging.root);
    manifest.status = "committed-awaiting-verification";
    manifest.committedAt = isoNow();
    manifest.committedSha256 = committedSha;
    manifest.commitAttestationPath = path.resolve(attestationPath);
    manifest.commitIntent.completedAt = manifest.committedAt;
    await writeJsonAtomic(resolvedManifestPath, manifest);
    return {
      command: "commit",
      status: manifest.status,
      manifestPath: resolvedManifestPath,
      source: manifest.source.realPath,
      committedSha256: committedSha,
      stagingEmpty: true,
      next: "Check source status again, create a new idle or notLoaded attestation, and run verify_cleanup.mjs in a new Node process.",
    };
  } catch (error) {
    if (!sourceReplaced) {
      try {
        const sourceAfterFailure = await fingerprint(manifest.source.realPath, true);
        if (sameFingerprint(sourceAfterFailure, manifest.source.fingerprint, true)) {
          manifest.commitRecoveries = [...(manifest.commitRecoveries || []), {
            at: isoNow(),
            outcome: "source-not-replaced",
            error: error.message,
            intent: manifest.commitIntent,
          }];
          delete manifest.commitIntent;
          manifest.status = "prepared";
          await writeJsonAtomic(resolvedManifestPath, manifest);
        }
      } catch {
        // Leave commit-intent-recorded in place for deterministic recovery.
      }
      throw new CleanupError("Commit aborted before source write", {
        cause: error.message,
        rawBackupPath: manifest.backup.rawPath,
      });
    }
    try {
      await restoreRaw(
        manifest,
        `commit failure: ${error.message}`,
        () => validateAttestation(manifest, attestationPath),
      );
    } catch (rollbackError) {
      manifest.status = "rollback-failed";
      manifest.rollback = { at: isoNow(), reason: error.message, error: rollbackError.message };
      await writeJsonAtomic(resolvedManifestPath, manifest).catch(() => {});
      throw new CleanupError("Commit failed and automatic rollback also failed", {
        commitError: error.message,
        rollbackError: rollbackError.message,
        rawBackupPath: manifest.backup.rawPath,
      });
    }
    throw new CleanupError("Commit failed; the original raw session was restored and verified", {
      cause: error.message,
      rawBackupPath: manifest.backup.rawPath,
    });
  }
}

async function rollback(manifestPath, attestationPath) {
  const resolved = path.resolve(manifestPath);
  const manifest = await readJson(resolved);
  assert(["committed-awaiting-verification", "verification-failed", "rollback-failed"].includes(manifest.status),
    "Rollback requires a committed, verification-failed, or rollback-failed transaction", {
      status: manifest.status,
    });
  await restoreRaw(
    manifest,
    "manual rollback requested after authoritative idle or notLoaded check",
    () => validateAttestation(manifest, attestationPath),
  );
  await assertStagingEmpty(manifest.staging.root);
  return {
    command: "rollback",
    status: "rolled-back",
    source: manifest.source.realPath,
    restoredSha256: manifest.source.originalSha256,
    rawBackupPath: manifest.backup.rawPath,
    stagingEmpty: true,
  };
}

async function abort(manifestPath) {
  const resolved = path.resolve(manifestPath);
  const manifest = await readJson(resolved);
  assert(manifest.status === "prepared", "Only a prepared transaction can be aborted without a state attestation", {
    status: manifest.status,
  });
  const sourceNow = await fingerprint(manifest.source.realPath, true);
  const sourceChangedSincePrepare = !sameFingerprint(sourceNow, manifest.source.fingerprint, true);
  await unlink(manifest.staging.cleanedPath).catch(() => {});
  manifest.status = "aborted";
  manifest.abortedAt = isoNow();
  manifest.abort = {
    reason: sourceChangedSincePrepare
      ? "prepared transaction became stale because the source changed"
      : "prepared transaction cancelled before commit",
    sourceChangedSincePrepare,
    sourceFingerprintAtAbort: sourceNow,
    sourceWritePerformed: false,
    rawBackupPreserved: true,
  };
  await writeJsonAtomic(resolved, manifest);
  await unlink(manifest.lockPath).catch(() => {});
  await assertStagingEmpty(manifest.staging.root);
  return {
    command: "abort",
    status: "aborted",
    manifestPath: resolved,
    rawBackupPath: manifest.backup.rawPath,
    sourceChangedSincePrepare,
    sourceWritePerformed: false,
    rawBackupPreserved: true,
    stagingEmpty: true,
  };
}

function usage() {
  return [
    "Usage:",
    "  node session_cleanup.mjs configure [backup-root]",
    "  node session_cleanup.mjs resolve <source-task-id> [sessions-root]",
    "  node session_cleanup.mjs inspect <session-jsonl>",
    "  node session_cleanup.mjs prepare <session-jsonl> <source-task-id> [one-time-backup-root]",
    "  node session_cleanup.mjs attest <manifest> <source-status> <checker-task-id> <checker-session-id> <checker-kind> <checker-transcript-jsonl> [forked-from-id|none]",
    "  node session_cleanup.mjs commit <manifest> <state-attestation>",
    "  node session_cleanup.mjs rollback <manifest> <state-attestation>",
    "  node session_cleanup.mjs abort <manifest>",
  ].join("\n");
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "configure" && args.length <= 1) return configure(args[0]);
  if (command === "resolve" && args.length >= 1 && args.length <= 2) return resolveSessionById(...args);
  if (command === "inspect" && args.length === 1) return inspect(args[0]);
  if (command === "prepare" && args.length >= 2 && args.length <= 3) return prepare(...args);
  if (command === "attest" && args.length >= 6 && args.length <= 7) return createAttestation(...args);
  if (command === "commit" && args.length === 2) return commit(args[0], args[1]);
  if (command === "rollback" && args.length === 2) return rollback(args[0], args[1]);
  if (command === "abort" && args.length === 1) return abort(args[0]);
  throw new CleanupError(usage());
}

main(process.argv.slice(2))
  .then(jsonOut)
  .catch((error) => {
    const payload = {
      ok: false,
      error: error.message,
      details: error.details || {},
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
