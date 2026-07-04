import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "skills/session-handoff/scripts/create_handoff.py"
NEW_SESSION_PROTOCOL_PATH = (
    REPO_ROOT / "skills/session-handoff/references/protocol/NEW_SESSION_PROTOCOL.md"
)


def load_create_handoff_module():
    spec = importlib.util.spec_from_file_location("create_handoff", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class CreateHandoffTests(unittest.TestCase):
    def test_generated_resume_instructions_include_active_profile(self):
        module = load_create_handoff_module()

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            handoff_home = tmp_path / "handoff-home"
            project_root = tmp_path / "project"
            project_root.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=project_root, check=True)

            old_home = os.environ.get("SESSION_HANDOFF_HOME")
            os.environ["SESSION_HANDOFF_HOME"] = str(handoff_home)
            try:
                result = module.create_handoff(
                    Namespace(
                        agent="codex",
                        project_root=str(project_root),
                        title="Profile Test",
                        session_id="test-session",
                        profile="auto",
                        lineage_id=None,
                        parent_handoff_id=None,
                        refresh_protocol=False,
                    )
                )
            finally:
                if old_home is None:
                    os.environ.pop("SESSION_HANDOFF_HOME", None)
                else:
                    os.environ["SESSION_HANDOFF_HOME"] = old_home

            profile_path = result["manifest"]["protocol_paths"]["profile"]
            handoff_dir = Path(result["handoff_dir"])
            start_here = (handoff_dir / "START_HERE.md").read_text(encoding="utf-8")
            next_prompt = (handoff_dir / "next-session-prompt.md").read_text(encoding="utf-8")

            self.assertIn(profile_path, start_here)
            self.assertIn(profile_path, next_prompt)

    def test_resume_protocol_preserves_lineage_for_future_handoffs(self):
        protocol = NEW_SESSION_PROTOCOL_PATH.read_text(encoding="utf-8")

        self.assertIn("lineage_id", protocol)
        self.assertIn("--parent-handoff-id", protocol)

    def test_handoffs_can_be_chained_by_lineage(self):
        module = load_create_handoff_module()

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            handoff_home = tmp_path / "handoff-home"
            project_root = tmp_path / "project"
            project_root.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=project_root, check=True)

            old_home = os.environ.get("SESSION_HANDOFF_HOME")
            os.environ["SESSION_HANDOFF_HOME"] = str(handoff_home)
            try:
                first = module.create_handoff(
                    Namespace(
                        agent="codex",
                        project_root=str(project_root),
                        title="Lineage Test",
                        session_id="first-session",
                        profile="auto",
                        lineage_id=None,
                        parent_handoff_id=None,
                        refresh_protocol=False,
                    )
                )
                second = module.create_handoff(
                    Namespace(
                        agent="codex",
                        project_root=str(project_root),
                        title="Lineage Test Continued",
                        session_id="second-session",
                        profile="auto",
                        lineage_id=None,
                        parent_handoff_id=first["handoff_id"],
                        refresh_protocol=False,
                    )
                )
            finally:
                if old_home is None:
                    os.environ.pop("SESSION_HANDOFF_HOME", None)
                else:
                    os.environ["SESSION_HANDOFF_HOME"] = old_home

            first_manifest = first["manifest"]
            second_manifest = second["manifest"]

            self.assertEqual(first_manifest["sequence"], 1)
            self.assertIsNone(first_manifest["parent_handoff_id"])
            self.assertEqual(second_manifest["lineage_id"], first_manifest["lineage_id"])
            self.assertEqual(second_manifest["parent_handoff_id"], first["handoff_id"])
            self.assertEqual(second_manifest["sequence"], 2)

            registry_lines = (handoff_home / "registry.jsonl").read_text(encoding="utf-8").splitlines()
            registry_rows = [json.loads(line) for line in registry_lines]
            self.assertEqual([row["sequence"] for row in registry_rows], [1, 2])
            self.assertEqual(registry_rows[-1]["lineage_id"], first_manifest["lineage_id"])

            index = json.loads((handoff_home / "index.json").read_text(encoding="utf-8"))
            lineage_index = index["lineages"][first_manifest["lineage_id"]]
            self.assertEqual(lineage_index["latest_handoff_id"], second["handoff_id"])
            self.assertEqual(lineage_index["sequence"], 2)
            self.assertEqual(lineage_index["handoff_ids"], [first["handoff_id"], second["handoff_id"]])
            self.assertIn(first_manifest["lineage_id"], index["projects"][second_manifest["project_fingerprint"]]["lineage_ids"])

    def test_index_only_includes_lineage_aware_registry_rows(self):
        module = load_create_handoff_module()

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            handoff_home = tmp_path / "handoff-home"
            handoff_home.mkdir()
            unlinked_row = {
                "created_at": "2026-01-01T00:00:00+08:00",
                "handoff_id": "unlinked-handoff",
                "handoff_dir": str(handoff_home / "handoffs/2026/01/unlinked-handoff"),
                "agent": "codex",
                "profile": "code",
                "project_short_name": "unlinked-project",
                "project_fingerprint": "unlinked-fingerprint",
                "source_root": "/tmp/unlinked-project",
                "source_session_id": None,
                "title": "Unlinked Project",
            }
            with (handoff_home / "registry.jsonl").open("w", encoding="utf-8") as fh:
                fh.write(json.dumps(unlinked_row, sort_keys=True) + "\n")

            project_root = tmp_path / "project"
            project_root.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=project_root, check=True)

            old_home = os.environ.get("SESSION_HANDOFF_HOME")
            os.environ["SESSION_HANDOFF_HOME"] = str(handoff_home)
            try:
                module.create_handoff(
                    Namespace(
                        agent="codex",
                        project_root=str(project_root),
                        title="New Project",
                        session_id="new-session",
                        profile="auto",
                        lineage_id=None,
                        parent_handoff_id=None,
                        refresh_protocol=False,
                    )
                )
            finally:
                if old_home is None:
                    os.environ.pop("SESSION_HANDOFF_HOME", None)
                else:
                    os.environ["SESSION_HANDOFF_HOME"] = old_home

            index = json.loads((handoff_home / "index.json").read_text(encoding="utf-8"))
            self.assertNotIn("unlinked-handoff", index["lineages"])
            self.assertNotIn("unlinked-fingerprint", index["projects"])

            old_home = os.environ.get("SESSION_HANDOFF_HOME")
            os.environ["SESSION_HANDOFF_HOME"] = str(handoff_home)
            try:
                with self.assertRaisesRegex(ValueError, "missing lineage_id"):
                    module.create_handoff(
                        Namespace(
                            agent="codex",
                            project_root=str(project_root),
                            title="Invalid Unlinked Parent",
                            session_id="new-session-2",
                            profile="auto",
                            lineage_id=None,
                            parent_handoff_id="unlinked-handoff",
                            refresh_protocol=False,
                        )
                    )
            finally:
                if old_home is None:
                    os.environ.pop("SESSION_HANDOFF_HOME", None)
                else:
                    os.environ["SESSION_HANDOFF_HOME"] = old_home


if __name__ == "__main__":
    unittest.main()
