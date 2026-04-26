# Session Handoff

Session Handoff is a Codex skill for moving long-running AI work from one session to the next without losing context, overwriting project notes, or scattering handoff files across repositories.

It creates a centralized handoff vault, writes an immutable snapshot for the current session, and returns a short prompt that the next AI session can use to resume from the right files.

## What It Does

- Stores handoffs in one central location instead of the project directory.
- Creates a unique handoff folder for every migration.
- Supports general long-running work and code project handoffs.
- Records project identity, current status, previous-session work, access gaps, verification state, and next actions.
- Uses a fixed new-session protocol so users only copy a short resume prompt.
- Tracks secret handling decisions without writing plaintext secrets by default.

## Install

Ask Codex to install this skill from GitHub:

```text
Install the Codex skill from https://github.com/Liu-Bot24/session-handoff-skill/tree/main/skills/session-handoff
```

Then restart Codex so the new skill is loaded.

## Use

When a session is getting long, ask:

```text
Use session-handoff to create a handoff for this session.
```

Codex will create the handoff snapshot and return a short prompt for the next session.

## Configuration

| Setting | Controls | Default |
|---|---|---|
| `SESSION_HANDOFF_HOME` | Where handoff snapshots and protocols are stored | `~/.handoffs` |

The default vault is local to the machine. The skill does not write handoff files into the project directory unless the user explicitly asks for project-local changes later.

## Secret Handling

Plaintext secrets are not written by default. The skill records safe indexes such as environment variable names, credential paths, SSH config hosts, CLI profiles, keychain items, password manager items, and browser login state.

If a plaintext secret appears in the current session or in an obvious temporary local file, the skill asks the user how it should be transferred before writing it anywhere.
