# New Session Protocol

Use this protocol when resuming from a centralized session handoff.

## Read Order

1. Read this protocol.
2. Read the handoff directory's `START_HERE.md`.
3. Read every file listed in `START_HERE.md` before the first pickup report.
4. At minimum, the handoff directory must include `manifest.json`, `handoff.md`, `ledger.md`, `brief.md`, `access.md`, `secret-decisions.md`, and `verification.md`.

If any required file is missing or unreadable, report it as a handoff integrity issue in the first response.

## First Response Requirements

Before changing files, running risky commands, publishing, deleting, restarting, committing, or migrating anything, provide a short pickup report:

- Which protocol and handoff files were read.
- What the previous session did, summarized from `ledger.md` and cross-checked against `handoff.md`.
- Whether the current working directory matches the handoff's project identity.
- Which facts are verified, stale, unverified, or known expired.
- Missing secrets, authorization files, login state, browser session, CLI profile, or access.
- What each missing access item is for and what it blocks.
- Whether an alternative path exists.
- The next safe action.

## Project Root Binding

The handoff's `source_root` is where the previous session created the handoff. It is not automatically the correct root for this session.

Use the current working directory as `PROJECT_ROOT` only after identity verification:

- For git projects, compare remote URL, repo root markers, branch context, and relevant manifest files.
- For non-git work, compare project name, durable paths, key resources, and the handoff's stated identity.
- If identity does not match, explain the mismatch and ask the user whether to switch directories.

Use logical paths such as `PROJECT_ROOT/...` in reasoning. Treat absolute paths from older sessions as historical unless reverified.

## Access And Secret Check

Read `access.md` and `secret-decisions.md` before attempting work that needs permissions.

In the first response, report missing access if any of these are absent or stale:

- environment variable,
- credential or config file,
- SSH config host or key path,
- CLI login or profile,
- browser session,
- keychain or password manager item,
- API key, token, cookie, password, private key, or OAuth refresh token.

Do not ask the user to restate access information already indexed in `access.md`.
Do not print, copy, summarize, or leak plaintext secrets.

If access is missing, say what is missing, what it is used for, what is blocked, and whether there is a safe alternative.

## Safety

- Treat unverified information as a clue, not a fact.
- Prefer read-only checks before writes.
- Do not repeat work marked complete unless verification contradicts it.
- Before high-impact actions, explain risk, impact, and rollback path.
