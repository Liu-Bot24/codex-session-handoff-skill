import base64
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
CLEANER = REPO_ROOT / "skills/session-cleanup/scripts/session_cleanup.mjs"
VERIFIER = REPO_ROOT / "skills/session-cleanup/scripts/verify_cleanup.mjs"
SOURCE_ID = "11111111-1111-4111-8111-111111111111"
WORKER_ID = "22222222-2222-4222-8222-222222222222"


class SkillPackageStructureTests(unittest.TestCase):
    def test_handoff_and_cleanup_are_independent_skill_entries(self):
        handoff = REPO_ROOT / "skills/session-handoff"
        cleanup = REPO_ROOT / "skills/session-cleanup"
        self.assertTrue((handoff / "SKILL.md").is_file())
        self.assertTrue((cleanup / "SKILL.md").is_file())
        self.assertTrue((handoff / "LICENSE").is_file())
        self.assertTrue((cleanup / "LICENSE").is_file())
        self.assertIn('display_name: "Session Handoff"', (handoff / "agents/openai.yaml").read_text(encoding="utf-8"))
        self.assertIn('display_name: "Session Cleanup"', (cleanup / "agents/openai.yaml").read_text(encoding="utf-8"))
        handoff_skill = (handoff / "SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("session-cleanup", handoff_skill.lower())
        self.assertFalse((REPO_ROOT / ".codex-plugin").exists())
        self.assertFalse((REPO_ROOT / "hooks").exists())

    def test_cleanup_documents_source_and_direct_target_modes(self):
        cleanup_skill = (REPO_ROOT / "skills/session-cleanup/SKILL.md").read_text(encoding="utf-8")
        safety_contract = (REPO_ROOT / "skills/session-cleanup/references/SAFETY_CONTRACT.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("Start from the source task", cleanup_skill)
        self.assertIn("Start from another top-level task", cleanup_skill)
        self.assertIn("Do not create a third task", cleanup_skill)
        self.assertIn("Write in the user's language", cleanup_skill)
        self.assertIn("请完全退出并重启 Codex，然后重新打开已清理的任务。", cleanup_skill)
        self.assertIn("无需重启 Codex。", cleanup_skill)
        self.assertIn("follow exactly one matching completion form", safety_contract)
        self.assertIn("legacy-id-only", cleanup_skill)
        self.assertIn("legacy-id-only", safety_contract)
        self.assertIn("present but empty, null", cleanup_skill)


class SessionCleanupTests(unittest.TestCase):
    def run_node(self, script, *args, env, check=True):
        result = subprocess.run(
            ["node", str(script), *map(str, args)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if check and result.returncode != 0:
            self.fail(f"command failed ({result.returncode}):\nstdout={result.stdout}\nstderr={result.stderr}")
        payload_text = result.stdout if result.returncode == 0 else result.stderr
        payload = json.loads(payload_text) if payload_text.strip() else {}
        return result, payload

    def configured_fixture(self, tmp_path):
        codex_home = tmp_path / "codex-home"
        backup_root = tmp_path / "portable-backups"
        env = os.environ.copy()
        env["CODEX_HOME"] = str(codex_home)
        _, configured = self.run_node(CLEANER, "configure", backup_root, env=env)
        self.assertEqual(configured["backupRoot"], str(backup_root.resolve()))
        return env, backup_root

    def write_session_fixture(self, tmp_path):
        image_a = b"A" * 5000
        image_b = b"B" * 4096
        uri_a = "data:image/png;base64," + base64.b64encode(image_a).decode("ascii")
        uri_a_unpadded = uri_a.rstrip("=")
        uri_b = "data:image/jpeg;base64," + base64.b64encode(image_b).decode("ascii")
        short_example = "data:image/png;base64,QUJD"
        malformed_long = "data:image/png;base64," + ("A" * 5000) + "!"
        records = [
            {
                "type": "session_meta",
                "payload": {
                    "id": SOURCE_ID,
                    "session_id": SOURCE_ID,
                    "timestamp": "2026-08-17T00:00:00.000Z",
                    "cwd": str(tmp_path),
                },
            },
            {
                "type": "event",
                "text": "all ordinary text survives",
                "reasoning_summary": "keep this reasoning summary",
                "local_path": r"C:\images\one.png",
                "http_url": "https://example.test/image.png",
                "filename": "one.png",
                "short_example": short_example,
                "malformed_example": malformed_long,
                "unique_image": {"image_url": uri_b},
            },
            {
                "type": "compacted",
                "replacement_history": [
                    {"deep": {"input_image": {"image_url": uri_a}}},
                    {"deeper": [{"image_url": uri_a_unpadded}]},
                ],
                "large_integer": 123456789012345678901234567890,
                "events": ["keep", "every", "event"],
            },
        ]
        source = tmp_path / f"rollout-2026-08-17T08-00-00-{SOURCE_ID}.jsonl"
        source_text = "".join(json.dumps(record, separators=(",", ":")) + "\n" for record in records)
        source.write_text(source_text, encoding="utf-8")
        worker = tmp_path / f"{WORKER_ID}.jsonl"
        worker.write_text(
            json.dumps(
                {"type": "session_meta", "payload": {"id": WORKER_ID, "session_id": WORKER_ID}},
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        return source, worker, source_text, records

    def write_identity_only_session(
        self,
        target,
        source_id=SOURCE_ID,
        *,
        session_id=SOURCE_ID,
        include_session_id=True,
    ):
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "id": source_id,
            "timestamp": "2026-08-17T00:00:00.000Z",
            "cwd": str(target.parent),
        }
        if include_session_id:
            payload["session_id"] = session_id
        target.write_text(
            json.dumps(
                {
                    "type": "session_meta",
                    "payload": payload,
                },
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )

    def create_attestation(self, env, manifest, worker, source_status="notLoaded"):
        _, proof = self.run_node(
            CLEANER,
            "attest",
            manifest,
            source_status,
            WORKER_ID,
            WORKER_ID,
            "root",
            worker,
            "none",
            env=env,
        )
        return proof["attestationPath"]

    def write_atomic_write_failure_preload(self, tmp_path, pattern, base_env=None):
        preload = tmp_path / "inject-atomic-json-write-failure.cjs"
        preload.write_text(
            """
const fsp = require("node:fs/promises");
const originalOpen = fsp.open;
let injected = false;
fsp.open = async function patchedOpen(target, ...args) {
  const handle = await originalOpen(target, ...args);
  if (!injected && String(target).includes(process.env.SESSION_CLEANUP_TEST_TEMP_PATTERN)) {
    const originalWriteFile = handle.writeFile.bind(handle);
    handle.writeFile = async function patchedWriteFile(...writeArgs) {
      await originalWriteFile(...writeArgs);
      injected = true;
      throw new Error("injected atomic JSON write failure");
    };
  }
  return handle;
};
""".strip()
            + "\n",
            encoding="utf-8",
        )
        env = (base_env or os.environ).copy()
        env["NODE_OPTIONS"] = f"--require={preload}"
        env["SESSION_CLEANUP_TEST_TEMP_PATTERN"] = pattern
        return env

    def test_configure_creates_and_probes_portable_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            codex_home = tmp_path / "codex-home"
            env = os.environ.copy()
            env["CODEX_HOME"] = str(codex_home)
            _, result = self.run_node(CLEANER, "configure", env=env)
            expected = codex_home / "session-cleanup/backups"
            self.assertEqual(Path(result["backupRoot"]), expected.resolve())
            self.assertTrue(expected.is_dir())
            self.assertTrue(result["directoryVerified"])
            self.assertIn(str(expected.resolve()), result["installAssistantMessage"])
            config = json.loads((codex_home / "session-cleanup/config.json").read_text(encoding="utf-8"))
            self.assertEqual(Path(config["backupRoot"]), expected.resolve())
            replacement = tmp_path / "user-selected-backups"
            _, changed = self.run_node(CLEANER, "configure", replacement, env=env)
            self.assertEqual(Path(changed["backupRoot"]), replacement.resolve())
            _, reused = self.run_node(CLEANER, "configure", env=env)
            self.assertEqual(Path(reused["backupRoot"]), replacement.resolve())

    def test_atomic_json_write_failure_removes_cleaner_temporary_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env = os.environ.copy()
            env["CODEX_HOME"] = str(tmp_path / "codex-home")
            failing_env = self.write_atomic_write_failure_preload(tmp_path, ".tmp-")
            failing_env["CODEX_HOME"] = env["CODEX_HOME"]

            result, error = self.run_node(
                CLEANER, "configure", tmp_path / "backups", env=failing_env, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("injected atomic JSON write failure", error["error"])
            config_dir = Path(env["CODEX_HOME"]) / "session-cleanup"
            self.assertEqual([path for path in config_dir.iterdir() if ".tmp-" in path.name], [])

    def test_resolve_accepts_real_rollout_name_and_legacy_exact_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env = os.environ.copy()
            codex_home = tmp_path / "codex-home"
            env["CODEX_HOME"] = str(codex_home)
            sessions_root = codex_home / "sessions"
            rollout = sessions_root / "2026/08/17" / f"rollout-2026-08-17T08-00-00-{SOURCE_ID}.jsonl"
            self.write_identity_only_session(rollout)

            _, resolved = self.run_node(CLEANER, "resolve", SOURCE_ID, env=env)
            self.assertEqual(Path(resolved["sessionPath"]), rollout.resolve())
            self.assertEqual(resolved["identity"]["id"], SOURCE_ID)
            self.assertEqual(resolved["identity"]["sessionId"], SOURCE_ID)
            self.assertTrue(resolved["identity"]["sessionIdPresent"])
            self.assertEqual(resolved["identity"]["format"], "current-dual-id")
            self.assertFalse(resolved["identity"]["requiresExternalTaskConfirmation"])

            rollout.unlink()
            legacy = sessions_root / "legacy" / f"{SOURCE_ID}.jsonl"
            self.write_identity_only_session(legacy)
            _, legacy_resolved = self.run_node(CLEANER, "resolve", SOURCE_ID, env=env)
            self.assertEqual(Path(legacy_resolved["sessionPath"]), legacy.resolve())

    def test_legacy_metadata_without_session_id_resolves_and_prepares_with_audit_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            sessions_root = Path(env["CODEX_HOME"]) / "sessions"
            source = sessions_root / "2026/06/20" / f"rollout-2026-06-20T20-36-08-{SOURCE_ID}.jsonl"
            self.write_identity_only_session(source, include_session_id=False)

            _, resolved = self.run_node(CLEANER, "resolve", SOURCE_ID, env=env)
            self.assertEqual(Path(resolved["sessionPath"]), source.resolve())
            self.assertEqual(resolved["identity"]["id"], SOURCE_ID)
            self.assertIsNone(resolved["identity"]["sessionId"])
            self.assertFalse(resolved["identity"]["sessionIdPresent"])
            self.assertEqual(resolved["identity"]["format"], "legacy-id-only")
            self.assertTrue(resolved["identity"]["requiresExternalTaskConfirmation"])

            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            manifest_path = Path(prepared["manifestPath"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["source"]["identity"], resolved["identity"])
            self.run_node(CLEANER, "abort", manifest_path, env=env)

    def test_resolve_rejects_metadata_mismatch_and_ambiguous_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env = os.environ.copy()
            codex_home = tmp_path / "codex-home"
            env["CODEX_HOME"] = str(codex_home)
            sessions_root = codex_home / "sessions"
            candidate = sessions_root / "2026/08/17" / f"rollout-2026-08-17T08-00-00-{SOURCE_ID}.jsonl"
            self.write_identity_only_session(candidate, WORKER_ID)

            result, error = self.run_node(CLEANER, "resolve", SOURCE_ID, env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("payload.id", error["error"])

            self.write_identity_only_session(candidate)
            duplicate = sessions_root / "2026/08/18" / f"rollout-2026-08-18T08-00-00-{SOURCE_ID}.jsonl"
            self.write_identity_only_session(duplicate)
            result, error = self.run_node(CLEANER, "resolve", SOURCE_ID, env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("exactly one", error["error"])
            self.assertEqual(error["details"]["matchCount"], 2)

    def test_legacy_and_current_metadata_mismatches_remain_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env = os.environ.copy()
            codex_home = tmp_path / "codex-home"
            env["CODEX_HOME"] = str(codex_home)
            sessions_root = codex_home / "sessions"
            candidate = sessions_root / "2026/06/20" / f"rollout-2026-06-20T20-36-08-{SOURCE_ID}.jsonl"

            self.write_identity_only_session(candidate, WORKER_ID, include_session_id=False)
            result, error = self.run_node(CLEANER, "resolve", SOURCE_ID, env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("payload.id", error["error"])

            self.write_identity_only_session(candidate, session_id=None)
            result, error = self.run_node(CLEANER, "resolve", SOURCE_ID, env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("payload.session_id", error["error"])

            self.write_identity_only_session(candidate, session_id=WORKER_ID)
            result, error = self.run_node(CLEANER, "resolve", SOURCE_ID, env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("payload.session_id", error["error"])

    def test_one_time_backup_root_does_not_replace_saved_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, saved_root = self.configured_fixture(tmp_path)
            source, _, _, _ = self.write_session_fixture(tmp_path)
            one_time_root = (tmp_path / "one-time-backups").resolve()
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, one_time_root, env=env)
            self.assertEqual(Path(prepared["backupRoot"]), one_time_root)
            self.assertEqual(prepared["backupRootMode"], "one-time")
            config_path = Path(env["CODEX_HOME"]) / "session-cleanup/config.json"
            config = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(Path(config["backupRoot"]), saved_root.resolve())
            self.run_node(CLEANER, "abort", prepared["manifestPath"], env=env)
            self.assertEqual(list((one_time_root / "staging").iterdir()), [])

    def test_unavailable_replacement_is_reported_without_changing_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, saved_root = self.configured_fixture(tmp_path)
            blocked = tmp_path / "not-a-directory"
            blocked.write_text("occupied by a file", encoding="utf-8")
            result, error = self.run_node(CLEANER, "configure", blocked, env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no fallback", error["error"])
            self.assertEqual(
                error["details"]["userDecisionRequired"],
                ["use a temporary location once", "replace the saved default location"],
            )
            config_path = Path(env["CODEX_HOME"]) / "session-cleanup/config.json"
            config = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(Path(config["backupRoot"]), saved_root.resolve())

    def test_idle_and_not_loaded_attestations_are_accepted_but_unsafe_states_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, _, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            for source_status in ("idle", "notLoaded"):
                _, proof = self.run_node(
                    CLEANER,
                    "attest",
                    prepared["manifestPath"],
                    source_status,
                    WORKER_ID,
                    WORKER_ID,
                    "root",
                    worker,
                    "none",
                    env=env,
                )
                self.assertEqual(proof["sourceStatus"], source_status)

            for source_status in ("active", "inProgress"):
                unsafe_result, unsafe_error = self.run_node(
                    CLEANER,
                    "attest",
                    prepared["manifestPath"],
                    source_status,
                    WORKER_ID,
                    WORKER_ID,
                    "root",
                    worker,
                    "none",
                    env=env,
                    check=False,
                )
                self.assertNotEqual(unsafe_result.returncode, 0)
                self.assertIn("idle or notLoaded", unsafe_error["error"])
            same_result, same_error = self.run_node(
                CLEANER,
                "attest",
                prepared["manifestPath"],
                "notLoaded",
                SOURCE_ID,
                SOURCE_ID,
                "root",
                source,
                "none",
                env=env,
                check=False,
            )
            self.assertNotEqual(same_result.returncode, 0)
            self.assertIn("differ", same_error["error"])
            self.run_node(CLEANER, "abort", prepared["manifestPath"], env=env)

    def test_attestation_rejects_invalid_or_mismatched_worker_transcript(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, _, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)

            worker.write_text(json.dumps({"type": "worker"}) + "\n", encoding="utf-8")
            result, error = self.run_node(
                CLEANER, "attest", prepared["manifestPath"], "idle",
                WORKER_ID, WORKER_ID, "root", worker, "none", env=env, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("session_meta", error["error"])

            self.write_identity_only_session(worker, source_id=SOURCE_ID, session_id=SOURCE_ID)
            result, error = self.run_node(
                CLEANER, "attest", prepared["manifestPath"], "idle",
                WORKER_ID, WORKER_ID, "root", worker, "none", env=env, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("payload.id", error["error"])
            self.run_node(CLEANER, "abort", prepared["manifestPath"], env=env)

    def test_attestation_older_than_thirty_seconds_cannot_write_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, original, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            proof_path = Path(self.create_attestation(env, prepared["manifestPath"], worker, "idle"))
            proof = json.loads(proof_path.read_text(encoding="utf-8"))
            proof["checkedAt"] = (datetime.now(timezone.utc) - timedelta(seconds=45)).isoformat()
            proof_path.write_text(json.dumps(proof), encoding="utf-8")

            result, error = self.run_node(
                CLEANER, "commit", prepared["manifestPath"], proof_path, env=env, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("before source write", error["error"])
            self.assertEqual(source.read_text(encoding="utf-8"), original)
            self.run_node(CLEANER, "abort", prepared["manifestPath"], env=env)

    def test_commit_revalidates_worker_identity_before_source_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, original, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            proof = self.create_attestation(env, prepared["manifestPath"], worker, "idle")
            worker.write_text(json.dumps({"type": "worker"}) + "\n", encoding="utf-8")

            result, error = self.run_node(
                CLEANER, "commit", prepared["manifestPath"], proof, env=env, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("before source write", error["error"])
            self.assertEqual(source.read_text(encoding="utf-8"), original)
            self.run_node(CLEANER, "abort", prepared["manifestPath"], env=env)

    def test_nested_duplicates_are_removed_but_unique_and_negative_examples_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, backup_root = self.configured_fixture(tmp_path)
            source, worker, original_text, original_records = self.write_session_fixture(tmp_path)

            _, inspection = self.run_node(CLEANER, "inspect", source, env=env)
            self.assertEqual(inspection["summary"]["validLongImageOccurrences"], 3)
            self.assertEqual(inspection["summary"]["uniqueLongImages"], 2)
            self.assertEqual(inspection["summary"]["duplicateLongImages"], 1)
            self.assertEqual(inspection["summary"]["shortDataImageExamples"], 1)
            self.assertEqual(inspection["summary"]["invalidLongDataImages"], 1)

            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            self.assertEqual(Path(prepared["rawBackupPath"]).read_text(encoding="utf-8"), original_text)
            self.assertTrue(Path(prepared["rawSha256Path"]).is_file())
            self.assertTrue(Path(prepared["manifestPath"]).is_file())
            self.assertTrue((backup_root / "index.jsonl").is_file())

            pre_commit_proof = self.create_attestation(env, prepared["manifestPath"], worker, "idle")
            source_identity_before_commit = source.stat().st_ino
            _, committed = self.run_node(CLEANER, "commit", prepared["manifestPath"], pre_commit_proof, env=env)
            self.assertEqual(committed["status"], "committed-awaiting-verification")
            self.assertNotEqual(source.stat().st_ino, source_identity_before_commit)
            self.assertEqual(list((backup_root / "staging").iterdir()), [])

            post_commit_proof = self.create_attestation(env, prepared["manifestPath"], worker, "idle")
            _, verified = self.run_node(VERIFIER, prepared["manifestPath"], post_commit_proof, env=env)
            self.assertEqual(verified["status"], "verified")
            self.assertEqual(verified["uniqueImagesRetained"], 2)
            self.assertEqual(verified["duplicatePayloadsReplaced"], 1)
            self.assertEqual(Path(verified["backupRoot"]), backup_root.resolve())
            self.assertNotIn("stagingEmpty", verified)
            self.assertNotIn("restartRequired", verified)
            self.assertNotIn("restartGuidance", verified)

            cleaned_records = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(cleaned_records[0], original_records[0])
            self.assertEqual(cleaned_records[1], original_records[1])
            history = cleaned_records[2]["replacement_history"]
            self.assertEqual(history[0], original_records[2]["replacement_history"][0])
            self.assertTrue(history[1]["deeper"][0]["image_url"].startswith("[[session-cleanup:duplicate-image"))
            self.assertEqual(cleaned_records[2]["large_integer"], original_records[2]["large_integer"])
            self.assertEqual(cleaned_records[2]["events"], original_records[2]["events"])

    def test_verifier_recovers_source_replaced_before_commit_manifest_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, backup_root = self.configured_fixture(tmp_path)
            source, worker, _, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            pre_commit_proof = self.create_attestation(env, prepared["manifestPath"], worker, "idle")
            manifest_path = Path(prepared["manifestPath"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["status"] = "commit-intent-recorded"
            manifest["commitIntent"] = {
                "recordedAt": datetime.now(timezone.utc).isoformat(),
                "attestationPath": str(Path(pre_commit_proof).resolve()),
                "expectedOriginalSha256": manifest["source"]["originalSha256"],
                "expectedCleanedSha256": manifest["staging"]["cleanedSha256"],
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            cleaned_path = Path(manifest["staging"]["cleanedPath"])
            source.write_bytes(cleaned_path.read_bytes())

            post_commit_proof = self.create_attestation(env, manifest_path, worker, "idle")
            _, verified = self.run_node(VERIFIER, manifest_path, post_commit_proof, env=env)
            self.assertEqual(verified["status"], "verified")
            recovered = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(recovered["commitIntent"]["recovery"], "source-already-replaced")
            self.assertEqual(list((backup_root / "staging").iterdir()), [])

    def test_commit_recovers_intent_recorded_before_source_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, _, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            original_proof = self.create_attestation(env, prepared["manifestPath"], worker, "idle")
            manifest_path = Path(prepared["manifestPath"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["status"] = "commit-intent-recorded"
            manifest["commitIntent"] = {
                "recordedAt": datetime.now(timezone.utc).isoformat(),
                "attestationPath": str(Path(original_proof).resolve()),
                "expectedOriginalSha256": manifest["source"]["originalSha256"],
                "expectedCleanedSha256": manifest["staging"]["cleanedSha256"],
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            retry_proof = self.create_attestation(env, manifest_path, worker, "idle")
            _, committed = self.run_node(CLEANER, "commit", manifest_path, retry_proof, env=env)
            self.assertEqual(committed["status"], "committed-awaiting-verification")
            committed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(committed_manifest["commitRecoveries"][0]["outcome"], "source-not-replaced")
            post_commit_proof = self.create_attestation(env, manifest_path, worker, "idle")
            _, verified = self.run_node(VERIFIER, manifest_path, post_commit_proof, env=env)
            self.assertEqual(verified["status"], "verified")

    def test_interrupted_commit_with_unknown_source_content_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, _, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            original_proof = self.create_attestation(env, prepared["manifestPath"], worker, "idle")
            manifest_path = Path(prepared["manifestPath"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["status"] = "commit-intent-recorded"
            manifest["commitIntent"] = {
                "recordedAt": datetime.now(timezone.utc).isoformat(),
                "attestationPath": str(Path(original_proof).resolve()),
                "expectedOriginalSha256": manifest["source"]["originalSha256"],
                "expectedCleanedSha256": manifest["staging"]["cleanedSha256"],
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            source.write_text("unexpected content\n", encoding="utf-8")
            unexpected_source = source.read_bytes()

            retry_proof = self.create_attestation(env, manifest_path, worker, "idle")
            result, error = self.run_node(
                CLEANER, "commit", manifest_path, retry_proof, env=env, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("neither original nor cleaned", error["error"])
            self.assertEqual(source.read_bytes(), unexpected_source)
            unchanged_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(unchanged_manifest["status"], "commit-intent-recorded")

    def test_source_change_after_prepare_aborts_before_writeback(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, _, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            source.write_text(source.read_text(encoding="utf-8") + json.dumps({"late": "write"}) + "\n", encoding="utf-8")
            changed = source.read_bytes()
            proof = self.create_attestation(env, prepared["manifestPath"], worker)
            result, error = self.run_node(CLEANER, "commit", prepared["manifestPath"], proof, env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("changed", error["error"].lower())
            self.assertEqual(source.read_bytes(), changed)

    def test_abort_releases_stale_prepared_transaction_after_source_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, backup_root = self.configured_fixture(tmp_path)
            source, _, _, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            raw_backup = Path(prepared["rawBackupPath"])
            raw_before = raw_backup.read_bytes()

            source.write_text(
                source.read_text(encoding="utf-8") + json.dumps({"late": "write"}) + "\n",
                encoding="utf-8",
            )
            changed_source = source.read_bytes()

            _, aborted = self.run_node(CLEANER, "abort", prepared["manifestPath"], env=env)
            self.assertEqual(aborted["status"], "aborted")
            self.assertTrue(aborted["sourceChangedSincePrepare"])
            self.assertEqual(source.read_bytes(), changed_source)
            self.assertEqual(raw_backup.read_bytes(), raw_before)
            self.assertEqual(list((backup_root / "staging").iterdir()), [])
            self.assertEqual(list((backup_root / "locks").iterdir()), [])

            _, replacement = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            self.assertEqual(replacement["summary"]["before"]["jsonRecords"], 4)
            self.run_node(CLEANER, "abort", replacement["manifestPath"], env=env)

    def test_malformed_jsonl_fails_closed_without_source_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, backup_root = self.configured_fixture(tmp_path)
            source = tmp_path / f"rollout-2026-08-17T08-00-00-{SOURCE_ID}.jsonl"
            metadata = json.dumps(
                {"type": "session_meta", "payload": {"id": SOURCE_ID, "session_id": SOURCE_ID}},
                separators=(",", ":"),
            ).encode("utf-8")
            original = metadata + b'\n{"broken":\n'
            source.write_bytes(original)
            result, error = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Malformed JSONL", error["error"])
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(list((backup_root / "staging").iterdir()), [])
            self.assertEqual(list((backup_root / "locks").iterdir()), [])

    def test_independent_verifier_restores_raw_backup_after_tampering(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, backup_root = self.configured_fixture(tmp_path)
            source, worker, original_text, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            proof = self.create_attestation(env, prepared["manifestPath"], worker)
            self.run_node(CLEANER, "commit", prepared["manifestPath"], proof, env=env)
            source.write_text(source.read_text(encoding="utf-8") + json.dumps({"tampered": True}) + "\n", encoding="utf-8")
            post_proof = self.create_attestation(env, prepared["manifestPath"], worker)
            result, error = self.run_node(VERIFIER, prepared["manifestPath"], post_proof, env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("automatically restored", error["error"])
            self.assertEqual(source.read_text(encoding="utf-8"), original_text)
            manifest = json.loads(Path(prepared["manifestPath"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "rolled-back-after-verification-failure")
            self.assertEqual(list((backup_root / "staging").iterdir()), [])

    def test_verifier_atomic_json_failure_cleans_temp_and_restores_raw(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, original_text, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            proof = self.create_attestation(env, prepared["manifestPath"], worker, "idle")
            self.run_node(CLEANER, "commit", prepared["manifestPath"], proof, env=env)
            post_proof = self.create_attestation(env, prepared["manifestPath"], worker, "idle")
            failing_env = self.write_atomic_write_failure_preload(tmp_path, ".verify-tmp-")
            failing_env["CODEX_HOME"] = env["CODEX_HOME"]

            result, error = self.run_node(
                VERIFIER, prepared["manifestPath"], post_proof, env=failing_env, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("automatically restored", error["error"])
            self.assertEqual(source.read_text(encoding="utf-8"), original_text)
            manifest_path = Path(prepared["manifestPath"])
            self.assertEqual(
                [path for path in manifest_path.parent.iterdir() if ".verify-tmp-" in path.name],
                [],
            )

    def test_rollback_failed_accepts_fresh_attestation_for_manual_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, backup_root = self.configured_fixture(tmp_path)
            source, worker, original_text, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            proof = self.create_attestation(env, prepared["manifestPath"], worker, "idle")
            self.run_node(CLEANER, "commit", prepared["manifestPath"], proof, env=env)
            manifest_path = Path(prepared["manifestPath"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["status"] = "rollback-failed"
            manifest["verification"] = {
                "error": "simulated verification failure",
                "rollbackError": "simulated stale state proof",
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            fresh_proof = self.create_attestation(env, manifest_path, worker, "idle")
            _, rolled_back = self.run_node(CLEANER, "rollback", manifest_path, fresh_proof, env=env)
            self.assertEqual(rolled_back["status"], "rolled-back")
            self.assertEqual(source.read_text(encoding="utf-8"), original_text)
            self.assertEqual(list((backup_root / "staging").iterdir()), [])
            self.assertEqual(list((backup_root / "locks").iterdir()), [])

    def test_corrupt_raw_backup_never_overwrites_committed_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, _, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            proof = self.create_attestation(env, prepared["manifestPath"], worker)
            self.run_node(CLEANER, "commit", prepared["manifestPath"], proof, env=env)
            committed_source = source.read_bytes()
            raw_backup = Path(prepared["rawBackupPath"])
            raw_backup.write_bytes(raw_backup.read_bytes() + b"corrupt")

            post_proof = self.create_attestation(env, prepared["manifestPath"], worker)
            result, error = self.run_node(
                VERIFIER, prepared["manifestPath"], post_proof, env=env, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("rollback both failed", error["error"])
            self.assertEqual(source.read_bytes(), committed_source)

    def test_manual_rollback_with_corrupt_raw_never_overwrites_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, _ = self.configured_fixture(tmp_path)
            source, worker, _, _ = self.write_session_fixture(tmp_path)
            _, prepared = self.run_node(CLEANER, "prepare", source, SOURCE_ID, env=env)
            proof = self.create_attestation(env, prepared["manifestPath"], worker)
            self.run_node(CLEANER, "commit", prepared["manifestPath"], proof, env=env)
            committed_source = source.read_bytes()
            raw_backup = Path(prepared["rawBackupPath"])
            raw_backup.write_bytes(raw_backup.read_bytes() + b"corrupt")
            rollback_proof = self.create_attestation(env, prepared["manifestPath"], worker)

            result, error = self.run_node(
                CLEANER, "rollback", prepared["manifestPath"], rollback_proof, env=env, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Raw backup hash", error["error"])
            self.assertEqual(source.read_bytes(), committed_source)


if __name__ == "__main__":
    unittest.main()
