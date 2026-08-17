# codex-session-handoff-skill

![Stars](https://img.shields.io/github/stars/Liu-Bot24/codex-session-handoff-skill?style=flat&label=Stars&cache=20260704) ![Forks](https://img.shields.io/github/forks/Liu-Bot24/codex-session-handoff-skill?style=flat&label=Forks&cache=20260704) ![Views 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/codex-session-handoff-skill/views14d.svg?v=4) ![Clones 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/codex-session-handoff-skill/clones14d.svg?v=4)

This repository provides two Codex skills that can be installed and used independently. Session Handoff turns an overloaded long-running task into a local snapshot for a new session. Session Cleanup safely backs up and removes repeated embedded image data so work can continue in the original session afterward.

[简体中文](./README.md) | [English](./README.en.md)

## Installation

Send this to Codex:

```text
Install the Skills from this repository: https://github.com/Liu-Bot24/codex-session-handoff-skill
```

The installation includes `skills/session-handoff` and `skills/session-cleanup`. After Session Cleanup is installed, Codex displays the actual backup directory it created and verified, then asks whether it should be changed. Restart Codex so the new skills are loaded.

## Session Handoff

`codex-session-handoff-skill` solves AI session migration. After a long session, the current goal, completed work, validation results, missing permissions, and next actions are often scattered across chat history and project files. A new session can easily miss important context if it relies on the user to restate everything.

This skill turns the current state into an independent handoff snapshot stored in a local folder. After the snapshot is created, the skill returns a short prompt that the user can paste into the next AI session so it can read the right handoff files and continue.

### What You Can Do

- Create a handoff snapshot when a Codex session is running out of context
- Keep repeated handoffs in one local place instead of scattering them across project directories
- Track repeated handoffs for the same long-running work through a local index
- Record source directory, git state, validation results, and next actions for code projects
- Record goals, resources, required access, and pending work for non-code long-running tasks
- Let the next session report what the previous session did, what is missing, and what should happen next in its first reply

### How It Works

The default handoff folder is:

```text
~/.handoffs
```

You can change it with:

```bash
export SESSION_HANDOFF_HOME=/path/to/handoffs
```

Every handoff creates a new snapshot directory. By default, handoff files are written only to the local handoff folder, not to the project directory.

### Usage

When a session is getting long, ask Codex:

```text
Use session-handoff to create a handoff for this session.
```

Codex will create the handoff snapshot and return a short prompt for the next session.

The new session will read the generated handoff files and report in its first reply:

- which handoff files were read
- what the previous session did
- whether the current working directory is the same project or task
- whether access, secrets, authorization files, or login state are missing
- which information is still unconfirmed or possibly stale
- current blockers
- the next safe action

### Secrets And Credentials

Plaintext secrets are not written by default.

Handoff documents record safe references only, such as environment variable names, credential paths, SSH config hosts, CLI profiles, keychain items, password manager items, and browser login state.

If a plaintext secret appears in the current session, or if a secret is stored in an obvious temporary local `.md` / `.txt` file, the skill asks the user how it should be transferred before writing it anywhere.

## Session Cleanup

Session Cleanup is for Codex sessions that have grown unusually large because they contain repeated embedded images. It retains one complete copy of every unique image and replaces only later duplicate long `data:image` Base64 payloads.

Ordinary text, tool history, reasoning summaries, events, compacted records, and `replacement_history` are preserved. Local image paths, HTTP/HTTPS URLs, filenames, and short `data:image` code examples are not cleaned.

### Usage

Clean the current session:

```text
Use Session Cleanup to clean the current session.
```

Clean a specified task from another top-level session:

```text
Use Session Cleanup to clean task <task-id>.
```

When started from the original session, Cleanup creates a separate top-level session and waits until the original is no longer active before cleaning it. When started from another top-level session with a task ID, it cleans the specified task directly.

### Backup and Safety

Initial configuration creates and verifies `<CODEX_HOME>/session-cleanup/backups`, displays the actual absolute path, and asks whether it should be changed. The saved default can later be changed in natural language, or a temporary directory can be supplied for one cleanup.

Before every writeback, Cleanup creates a raw backup, SHA256, manifest, and index. It reports success only after independent verification and explicitly displays the backup location. After a successful cleanup, fully quit and restart Codex before reopening the original session.
