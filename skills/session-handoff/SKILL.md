---
name: session-handoff
description: Use when the user asks to create, migrate, resume, or design an AI session handoff; when context is nearly full; or when a long-running task needs a centralized handoff snapshot instead of project-local notes. Supports both general long-running work and code project handoffs.
---

# session-handoff

Create immutable AI session handoff snapshots in a central vault, not in the project directory.

## Defaults

- Handoff home: `$SESSION_HANDOFF_HOME`, or `~/.handoffs` if unset.
- Do not write handoff files into the project directory by default.
- Each handoff is a new immutable directory under the handoff home.
- Fixed reader rules live in the handoff home `protocol/` directory.
- Per-session state lives only in the generated handoff directory.
- Plaintext secrets are never written by default.

## Create A Handoff

When the user asks to migrate the current session, create a handoff, or prepare a new-session prompt:

1. Run the creation script:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/session-handoff/scripts/create_handoff.py" \
  --agent codex \
  --project-root "$PWD" \
  --title "<short human-readable title>"
```

Use `--profile code` for a code project, `--profile general` for non-code work, or omit it to auto-detect.
If the host exposes a stable session id, pass it with `--session-id`.

2. Perform only read-only verification before writing content.

For code projects, load `references/profiles/code.md` and capture its required state.
For non-code work, load `references/profiles/general.md` only if the generic sections are not enough.

3. Fill the generated files in the handoff directory:

- `handoff.md` - current session summary, status, risks, next actions.
- `brief.md` - stable objective, user preferences, durable context.
- `ledger.md` - durable work log, decisions, failed attempts.
- `access.md` - access and authorization index, no plaintext secrets by default.
- `secret-decisions.md` - secret transfer decisions and pending user choices.
- `verification.md` - read-only checks performed and freshness notes.

4. Secret handling:

- Treat direct plaintext values in the chat context as plaintext secrets.
- Treat obvious temporary `.md` / `.txt` secret storage inside the project as a secret transfer risk.
- System credential locations such as SSH key paths, keychain items, password manager items, CLI profiles, browser sessions, and normal config paths are indexes; record them without asking to copy plaintext.
- If plaintext secrets or temporary secret stores must be handed off, create a decision list and ask the user how to transfer them before writing values anywhere.
- Do not reprint full secret values in the chat. Use labels, purpose, source, and short fingerprints or suffixes.

5. Return the short prompt from `next-session-prompt.md` to the user.

## Resume From A Handoff

When the user gives a handoff directory and asks to resume:

1. Read `<handoff_home>/protocol/NEW_SESSION_PROTOCOL.md`.
2. Read the handoff directory's `START_HERE.md` and every file it lists, including `manifest.json`, `handoff.md`, `ledger.md`, `brief.md`, `access.md`, `secret-decisions.md`, and `verification.md`.
3. Bind the current working directory only after verifying project identity.
4. In the first reply, report:
   - files read,
   - what the previous session did, summarized from `ledger.md` and checked against `handoff.md`,
   - project identity match or mismatch,
   - missing secrets, authorization files, login state, or access,
   - stale or unverified facts,
   - blockers,
   - the next safe action.

## Implementation Notes

- The script installs protocol files into the handoff home if they are missing.
- The script updates `registry.jsonl` for traceability.
- The script creates scaffolds only; Codex is responsible for accurate content based on current verified state.
