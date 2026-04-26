# Code Project Handoff Profile

Use this profile when the handoff concerns a code repository or software project.

## Required Read-Only Checks

Run or otherwise capture:

- current working directory,
- git root if present,
- current branch,
- git remote summary,
- short status,
- recent local changes relevant to the task,
- untracked files that matter,
- active task files and modules,
- package or build metadata that identifies the project,
- test, lint, build, or typecheck commands already run,
- validation commands that still need to run,
- dev server, port, environment variable, database, migration, or deployment risks if relevant.

Do not run slow, destructive, publishing, migration, or network-changing commands unless the user explicitly asks.

## Required Handoff Content

In addition to the core handoff sections, include:

- `PROJECT_ROOT` binding guidance.
- Branch and remote state.
- Dirty worktree summary.
- Files changed and why.
- Files the next session should inspect first.
- Tests/checks already run with result summaries.
- Tests/checks not run and why.
- Known failing checks and suspected cause.
- Build/dev server state if relevant.
- Configuration and secret references needed for local execution.
- Rollback notes for risky code/config/data changes.

## First Resume Checks

The next session should verify:

- current directory is the same project,
- branch and dirty worktree still match the handoff,
- required dependencies or services are available,
- required access items from `access.md` are present,
- the next action is still valid after rechecking current files.
