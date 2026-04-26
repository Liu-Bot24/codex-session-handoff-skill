# codex-session-handoff-skill

A Codex skill that turns an overloaded long-running AI session into a local handoff snapshot that a fresh session can resume from.

[简体中文](./README.md) | [English](./README.en.md)

`codex-session-handoff-skill` solves AI session migration. After a long session, the current goal, completed work, validation results, missing permissions, and next actions are often scattered across chat history and project files. A new session can easily miss important context if it relies on the user to restate everything.

This skill turns the current state into an independent handoff snapshot stored in a local folder. After the snapshot is created, the skill returns a short prompt that the user can paste into the next AI session so it can read the right handoff files and continue.

## What You Can Do

- Create a handoff snapshot when a Codex session is running out of context
- Keep repeated handoffs in one local place instead of scattering them across project directories
- Record source directory, git state, validation results, and next actions for code projects
- Record goals, resources, required access, and pending work for non-code long-running tasks
- Let the next session report what the previous session did, what is missing, and what should happen next in its first reply

## How It Works

The default handoff folder is:

```text
~/.handoffs
```

You can change it with:

```bash
export SESSION_HANDOFF_HOME=/path/to/handoffs
```

Every handoff creates a new snapshot directory. By default, handoff files are written only to the local handoff folder, not to the project directory.

## Installation

Ask Codex to install this skill from GitHub:

```text
Install the Codex skill from https://github.com/Liu-Bot24/codex-session-handoff-skill/tree/main/skills/session-handoff
```

Then restart Codex so the new skill is loaded.

## Usage

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

## Secrets And Credentials

Plaintext secrets are not written by default.

Handoff documents record safe references only, such as environment variable names, credential paths, SSH config hosts, CLI profiles, keychain items, password manager items, and browser login state.

If a plaintext secret appears in the current session, or if a secret is stored in an obvious temporary local `.md` / `.txt` file, the skill asks the user how it should be transferred before writing it anywhere.
