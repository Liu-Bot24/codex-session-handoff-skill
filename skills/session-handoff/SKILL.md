---
name: session-handoff
description: 用于明确要求创建 AI 会话交接的场景：迁移当前 session、做会话交接、创建/生成交接快照、生成交接文档，或准备给新 session 使用的交接提示词。Creates local AI session handoff snapshots for code projects and general long-running work.
---

# session-handoff

Create AI session handoff snapshots in a local handoff folder, not in the project directory.

## Defaults

- Handoff folder: `$SESSION_HANDOFF_HOME`, or `~/.handoffs` if unset.
- Do not write handoff files into the project directory by default.
- Each handoff is a new directory under the handoff folder.
- Resume rules live in the handoff folder's `protocol/` directory.
- Per-session state lives only in the generated handoff directory.
- Plaintext secrets are never written by default.

## Create A Handoff

When the user explicitly asks to migrate the current session, create a handoff, write handoff documents, or prepare a new-session prompt:

1. Run the creation script:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/session-handoff/scripts/create_handoff.py" \
  --agent codex \
  --project-root "$PWD" \
  --title "<short human-readable title>"
```

Use `--profile code` for a code project, `--profile general` for non-code work, or omit it to auto-detect.
If the host exposes a stable session id, pass it with `--session-id`.
If the current session resumed from an existing handoff, pass that handoff's `lineage_id` and `handoff_id`:

```bash
--lineage-id "<lineage_id>" --parent-handoff-id "<handoff_id>"
```

Do not guess parentage from project name alone; omit these flags when starting an independent handoff chain.

2. Perform only read-only verification before writing content.

For code projects, load `references/profiles/code.md` and capture its required state.
For non-code work, load `references/profiles/general.md` only if the generic sections are not enough.

3. Fill the generated files in the handoff directory:

- `handoff.md` - current session summary, status, risks, next actions.
- `brief.md` - stable objective, user preferences, durable context.
- `ledger.md` - durable work log, decisions, failed attempts.
- `access.md` - where required credentials, logins, and permissions can be found; no plaintext secrets by default.
- `secret-decisions.md` - secret transfer decisions and pending user choices.
- `verification.md` - read-only checks performed and freshness notes.

4. Secret handling:

- Treat direct plaintext values in the chat context as plaintext secrets.
- Treat obvious temporary `.md` / `.txt` secret storage inside the project as a secret transfer risk.
- System credential locations such as SSH key paths, keychain items, password manager items, CLI profiles, browser sessions, and normal config paths are safe references; record them without asking to copy plaintext.
- If plaintext secrets or temporary secret stores must be handed off, create a decision list and ask the user how to transfer them before writing values anywhere.
- Do not reprint full secret values in the chat. Use labels, purpose, source, and short fingerprints or suffixes.

5. Return the short prompt from `next-session-prompt.md` to the user.

## Manual Restore Reference

The generated `next-session-prompt.md` is self-contained: it tells the new session which resume rules and handoff directory to read. A new session does not need this skill to trigger when the user pastes that prompt.

Use this section only if the user explicitly invokes this skill while providing a concrete handoff directory:

1. Read the resume rules under the handoff folder, usually `<handoff_folder>/protocol/NEW_SESSION_PROTOCOL.md`.
2. Read the handoff directory's `START_HERE.md` and every file it lists, including `manifest.json`, `handoff.md`, `ledger.md`, `brief.md`, `access.md`, `secret-decisions.md`, and `verification.md`.
3. Bind the current working directory only after verifying it is the same project or task.
4. Preserve `lineage_id` and `handoff_id` from `manifest.json` for any later handoff created from this resumed session.
5. In the first reply, report:
   - files read,
   - what the previous session did, summarized from `ledger.md` and checked against `handoff.md`,
   - whether the current directory is the same project or task,
   - missing secrets, authorization files, login state, or access,
   - stale or unverified facts,
   - blockers,
   - the next safe action.

## Implementation Notes

- The script installs resume-rule files into the handoff folder if they are missing.
- The script updates `registry.jsonl` and `index.json` for traceability and latest-handoff lookup.
- The script creates scaffolds only; Codex is responsible for accurate content based on current verified state.
