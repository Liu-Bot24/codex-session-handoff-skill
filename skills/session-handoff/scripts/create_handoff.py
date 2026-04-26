#!/usr/bin/env python3
"""Create a local immutable AI session handoff scaffold."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_ROOT = SKILL_ROOT / "references"
DEFAULT_HOME = "~/.handoffs"
SESSION_ID_ENV_CANDIDATES = (
    "CODEX_SESSION_ID",
    "CODEX_CONVERSATION_ID",
    "OPENAI_SESSION_ID",
    "CLAUDE_SESSION_ID",
    "AI_SESSION_ID",
)


def run(cmd: list[str], cwd: Path) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except Exception as exc:  # noqa: BLE001
        return 1, "", str(exc)


def slug(value: str, fallback: str, max_length: int = 48) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-._")
    return value[:max_length] or fallback


def short_hash(value: str, length: int = 12) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def get_session_id(cli_value: str | None) -> str | None:
    if cli_value:
        return cli_value.strip()
    for name in SESSION_ID_ENV_CANDIDATES:
        value = os.environ.get(name)
        if value:
            return value.strip()
    return None


def find_git_root(project_root: Path) -> Path | None:
    code, out, _ = run(["git", "rev-parse", "--show-toplevel"], project_root)
    if code == 0 and out:
        return Path(out).resolve()
    return None


def git_value(args: list[str], cwd: Path) -> str | None:
    code, out, _ = run(["git", *args], cwd)
    if code == 0 and out:
        return out
    return None


def detect_profile(project_root: Path, explicit: str) -> str:
    if explicit != "auto":
        return explicit
    if find_git_root(project_root):
        return "code"
    markers = (
        "package.json",
        "pyproject.toml",
        "Cargo.toml",
        "go.mod",
        "Gemfile",
        "pom.xml",
        "build.gradle",
        "Makefile",
    )
    if any((project_root / marker).exists() for marker in markers):
        return "code"
    return "general"


def project_info(project_root: Path, title: str | None, profile: str) -> dict[str, Any]:
    git_root = find_git_root(project_root)
    if git_root:
        origin = git_value(["config", "--get", "remote.origin.url"], git_root)
        branch = git_value(["branch", "--show-current"], git_root)
        top = str(git_root)
        basis = "|".join(x for x in (origin, top) if x)
        fingerprint_kind = "git-remote" if origin else "git-local"
        fingerprint = short_hash(basis)
        short_name = slug(title or Path(top).name, "project")
        return {
            "profile": profile,
            "project_short_name": short_name,
            "project_fingerprint": fingerprint,
            "project_fingerprint_kind": fingerprint_kind,
            "source_root": str(project_root),
            "git_root": top,
            "git_remote_origin": origin,
            "git_branch": branch,
        }

    marker_names = []
    for marker in ("package.json", "pyproject.toml", "README.md", "AGENTS.md", ".env.example"):
        if (project_root / marker).exists():
            marker_names.append(marker)
    basis = "|".join([str(project_root), *marker_names, title or ""])
    short_name = slug(title or project_root.name, "work")
    return {
        "profile": profile,
        "project_short_name": short_name,
        "project_fingerprint": short_hash(basis),
        "project_fingerprint_kind": "local-markers",
        "source_root": str(project_root),
        "git_root": None,
        "git_remote_origin": None,
        "git_branch": None,
    }


def install_protocol(handoff_home: Path, refresh: bool = False) -> None:
    protocol_dst = handoff_home / "protocol"
    profiles_dst = protocol_dst / "profiles"
    protocol_dst.mkdir(parents=True, exist_ok=True)
    profiles_dst.mkdir(parents=True, exist_ok=True)

    for src in (REFERENCE_ROOT / "protocol").glob("*.md"):
        dst = protocol_dst / src.name
        if refresh or not dst.exists():
            shutil.copyfile(src, dst)
    for src in (REFERENCE_ROOT / "profiles").glob("*.md"):
        dst = profiles_dst / src.name
        if refresh or not dst.exists():
            shutil.copyfile(src, dst)


def write_text(path: Path, text: str) -> None:
    path.write_text(text.rstrip() + "\n", encoding="utf-8")


def json_dump(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)


def template_start_here(manifest: dict[str, Any]) -> str:
    return f"""# Start Here

Handoff ID: {manifest["handoff_id"]}
Created at: {manifest["created_at"]}
Agent: {manifest["agent"]}
Profile: {manifest["profile"]}
Project: {manifest["project_short_name"]}
Source root at handoff: `{manifest["source_root"]}`

## Read Order

1. `{manifest["protocol_paths"]["new_session"]}`
2. `manifest.json`
3. `handoff.md`
4. `ledger.md`
5. `brief.md`
6. `access.md`
7. `secret-decisions.md`
8. `verification.md`

Follow the resume rules first. Treat this directory as the source of truth for this handoff snapshot.
"""


def template_handoff(manifest: dict[str, Any]) -> str:
    return f"""# Handoff

## Handoff Metadata

- Handoff ID: `{manifest["handoff_id"]}`
- Created at: {manifest["created_at"]}
- Agent: {manifest["agent"]}
- Profile: {manifest["profile"]}
- Project: {manifest["project_short_name"]}
- Source root at handoff: `{manifest["source_root"]}`
- Project check id: `{manifest["project_fingerprint_kind"]}:{manifest["project_fingerprint"]}`

## Human-Readable Session Summary

TODO: Summarize what this session did in objective, concise language.

## Current Mission

TODO: State the current small task.

## Current Status

- Completed:
- In progress:
- Not started:
- Blocked:

Mark each item as verified, unverified, possibly stale, or expired.

## Immediate Next Actions

- [ ] TODO

## Risks / Warnings

TODO: Include data loss, service interruption, config overwrite, permission leakage, and stale-state risks if relevant.

## Access / Permission Gaps Summary

TODO: Summarize `access.md` and `secret-decisions.md`. If no known gaps, say so explicitly.
"""


def template_brief(manifest: dict[str, Any]) -> str:
    return f"""# Brief

## Handoff Metadata

- Handoff ID: `{manifest["handoff_id"]}`
- Project: {manifest["project_short_name"]}
- Profile: {manifest["profile"]}

## Long-Term Objective

TODO

## User Preferences And Durable Rules

TODO

## Stable Environment / Assets

Use logical paths such as `PROJECT_ROOT/...` when possible. Treat old absolute paths as historical until reverified.

TODO
"""


def template_ledger(manifest: dict[str, Any]) -> str:
    return f"""# Ledger

## Handoff Metadata

- Handoff ID: `{manifest["handoff_id"]}`
- Project: {manifest["project_short_name"]}

## Session Work Summary

TODO

## Decisions

TODO

## Failed Attempts / Dead Ends

TODO
"""


def template_access(manifest: dict[str, Any]) -> str:
    return f"""# Access And Credentials

## Handoff Metadata

- Handoff ID: `{manifest["handoff_id"]}`
- Project: {manifest["project_short_name"]}

This file records where required credentials, logins, and permissions can be found. Do not write plaintext secrets here.

## Access Overview

TODO

## Required Credentials / Authorizations

| Purpose | Type | Name / Variable / Path / Item | Present? | Verification Status | How Next Session Should Use It | Blocking? |
|---|---|---|---|---|---|---|
| TODO | TODO | TODO | TODO | TODO | TODO | TODO |

## Missing Access Checklist

- [ ] Need:
  - Purpose:
  - What user should provide:
  - What is blocked:
  - Alternative:
  - Verification status:

## Safe Access Instructions

- Use the references in this file before asking the user to repeat information.
- Do not print secret values.
- Do not copy secrets into chat.
- Do not write plaintext secrets to tracked files.
"""


def template_secret_decisions(manifest: dict[str, Any]) -> str:
    return f"""# Secret Decisions

## Handoff Metadata

- Handoff ID: `{manifest["handoff_id"]}`
- Project: {manifest["project_short_name"]}

Follow `{manifest["protocol_paths"]["secret_transfer"]}`.

## Decision Table

| Label | Category | Purpose | Source / Reference | Decision | Blocking? | Notes |
|---|---|---|---|---|---|---|
| TODO | reference-only / plaintext-in-context / temporary-local-secret / missing-required / not-needed-now | TODO | TODO | TODO | TODO | TODO |

## Pending User Decisions

- [ ] TODO

Do not paste plaintext secret values in this file unless the user explicitly approves the destination and risk.
"""


def template_verification(manifest: dict[str, Any]) -> str:
    return f"""# Verification

## Handoff Metadata

- Handoff ID: `{manifest["handoff_id"]}`
- Project: {manifest["project_short_name"]}
- Created at: {manifest["created_at"]}

## Read-Only Checks Performed

| Object | Method | Time | Result Summary | Freshness |
|---|---|---|---|---|
| TODO | TODO | TODO | TODO | TODO |

## Verified Current Facts

TODO

## Unverified Or Possibly Stale Information

TODO

## Expired Information Found

TODO
"""


def template_prompt(manifest: dict[str, Any], handoff_dir: Path) -> str:
    return f"""你现在要恢复一个已经生成的会话交接。

请先读取恢复规则：

{manifest["protocol_paths"]["new_session"]}

然后读取本次交接目录：

{handoff_dir}

按恢复规则完成第一轮检查后，再继续执行。第一轮先反馈：已读取哪些文件、上一 session 主要做了什么（依据 ledger.md，并和 handoff.md 交叉核对）、当前工作目录是否是同一个项目或任务、权限/密钥/授权文件/登录态缺口、还没有确认或可能已经过期的信息、阻塞项、下一步安全动作。
"""


def create_handoff(args: argparse.Namespace) -> dict[str, Any]:
    handoff_home = Path(os.environ.get("SESSION_HANDOFF_HOME", DEFAULT_HOME)).expanduser().resolve()
    handoff_home.mkdir(parents=True, exist_ok=True)
    try:
        handoff_home.chmod(0o700)
    except OSError:
        pass

    install_protocol(handoff_home, refresh=args.refresh_protocol)

    project_root = Path(args.project_root).expanduser().resolve()
    profile = detect_profile(project_root, args.profile)
    info = project_info(project_root, args.title, profile)
    session_id = get_session_id(args.session_id)
    session_short = slug(session_id or "", "none", 24) if session_id else f"anon{random.randint(0, 0xFFFFFF):06x}"
    agent = slug(args.agent, "agent", 24)
    now = dt.datetime.now().astimezone()
    timestamp = now.strftime("%Y%m%d-%H%M%S")
    project_part = slug(info["project_short_name"], "work", 40)
    handoff_id = f"{timestamp}-{agent}-{project_part}-{session_short}"
    handoff_dir = handoff_home / "handoffs" / now.strftime("%Y") / now.strftime("%m") / handoff_id
    handoff_dir.mkdir(parents=True, exist_ok=False)

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "handoff_id": handoff_id,
        "created_at": now.isoformat(timespec="seconds"),
        "agent": agent,
        "source_session_id": session_id,
        "title": args.title,
        "profile": profile,
        "handoff_home": str(handoff_home),
        "handoff_dir": str(handoff_dir),
        "protocol_paths": {
            "new_session": str(handoff_home / "protocol" / "NEW_SESSION_PROTOCOL.md"),
            "secret_transfer": str(handoff_home / "protocol" / "SECRET_TRANSFER_PROTOCOL.md"),
            "profile": str(handoff_home / "protocol" / "profiles" / f"{profile}.md"),
        },
        "resume_policy": "Read resume rules, read this handoff, verify the current directory is the same project or task, then bind it as PROJECT_ROOT if it matches.",
        **info,
    }

    write_text(handoff_dir / "manifest.json", json_dump(manifest))
    write_text(handoff_dir / "START_HERE.md", template_start_here(manifest))
    write_text(handoff_dir / "handoff.md", template_handoff(manifest))
    write_text(handoff_dir / "brief.md", template_brief(manifest))
    write_text(handoff_dir / "ledger.md", template_ledger(manifest))
    write_text(handoff_dir / "access.md", template_access(manifest))
    write_text(handoff_dir / "secret-decisions.md", template_secret_decisions(manifest))
    write_text(handoff_dir / "verification.md", template_verification(manifest))
    prompt = template_prompt(manifest, handoff_dir)
    write_text(handoff_dir / "next-session-prompt.md", prompt)

    registry_entry = {
        "created_at": manifest["created_at"],
        "handoff_id": handoff_id,
        "handoff_dir": str(handoff_dir),
        "agent": agent,
        "profile": profile,
        "project_short_name": info["project_short_name"],
        "project_fingerprint": info["project_fingerprint"],
        "source_root": info["source_root"],
        "source_session_id": session_id,
        "title": args.title,
    }
    with (handoff_home / "registry.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(registry_entry, ensure_ascii=False, sort_keys=True) + "\n")

    return {
        "ok": True,
        "handoff_home": str(handoff_home),
        "handoff_dir": str(handoff_dir),
        "handoff_id": handoff_id,
        "profile": profile,
        "manifest": manifest,
        "next_session_prompt": prompt,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", default="codex", help="Agent name for human-readable ids.")
    parser.add_argument("--project-root", default=os.getcwd(), help="Source project/work root.")
    parser.add_argument("--title", default=None, help="Short human-readable title.")
    parser.add_argument("--session-id", default=None, help="Stable host session id, if available.")
    parser.add_argument("--profile", choices=("auto", "code", "general"), default="auto")
    parser.add_argument("--refresh-protocol", action="store_true", help="Overwrite resume-rule files in the handoff folder from skill references.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON only.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        result = create_handoff(args)
    except FileExistsError as exc:
        print(f"error: handoff directory already exists: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"Created handoff: {result['handoff_dir']}")
        print(f"Profile: {result['profile']}")
        print()
        print("Next-session prompt:")
        print(result["next_session_prompt"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
