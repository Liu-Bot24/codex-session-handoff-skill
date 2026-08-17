---
name: session-cleanup
description: Safely back up and deduplicate long embedded data:image Base64 payloads in an oversized Codex JSONL task while preserving one complete copy of every unique image and all non-image history. Use when the user asks for Session Cleanup, requests cleanup of the current Codex task or a specified task/session ID, reports a session bloated by duplicated embedded images, changes the cleanup backup location, or an AI-led GitHub installation must complete backup setup.
---

# Session Cleanup

Clean one Codex task through a separate top-level Codex task. Keep Session Cleanup independent from Session Handoff: cleanup returns the user to the original task after verification; it does not create a handoff snapshot.

Before inspecting or changing a task, read [`references/SAFETY_CONTRACT.md`](references/SAFETY_CONTRACT.md) completely and use the bundled scripts exactly in the required order.

## Install completion

When an AI installs this Skill from GitHub, finish installation in the same conversation:

1. Run `node "<session-cleanup-dir>/scripts/session_cleanup.mjs" configure`.
2. Require the command to create the selected directory and pass its write/flush/read/delete probe.
3. Send the returned `installAssistantMessage` to the user verbatim. It reports the actual absolute backup path and asks whether to change it.
4. If the user supplies another path, run `configure <absolute-backup-root>`, then send `configurationAssistantMessage`.

Persist configuration under the active `CODEX_HOME`, outside the installed Skill directory. When a configured path is unavailable, report the error and ask whether the replacement is temporary for one cleanup or should become the saved default. For a temporary choice, pass its absolute path as the third `prepare` argument without changing configuration. For a saved replacement, run `configure <absolute-backup-root>`. Make no silent fallback.

If manual installation skipped this exchange, perform it on the first explicit Session Cleanup request before creating a cleanup task. Do not ask again when valid saved configuration already exists.

## Start from the source task

Use this mode when the user invokes Session Cleanup in the task that should be cleaned.

1. Confirm the current task ID and host ID with Codex task tools. Resolve its transcript deterministically:

   ```text
   node "<session-cleanup-dir>/scripts/session_cleanup.mjs" resolve "<source-task-id>" ["<authoritative-sessions-root>"]
   ```

   Require exactly one returned transcript whose first record is `session_meta`. Accept `identity.format: current-dual-id` only when both `payload.id` and the present `payload.session_id` equal the task ID. Accept `identity.format: legacy-id-only` only when `payload.id` equals the task ID, the `session_id` property is absent, and the Codex task-tool result independently confirms the same task ID and host. A present but empty, null, or different `session_id` is unsafe. Never select a transcript by recency.
2. Create a separate top-level Codex task with the Codex task-creation tool. Put the source ID, source host ID, resolved JSONL path, and this Skill path in its prompt.
3. Treat collaboration agents, subagents, forks, and same-task workers as invalid cleanup workers. Require a different task ID, a root task whose task ID equals its session ID, no `forkedFromId`, and a distinct transcript real path.
4. End the current response after creating the cleanup task so the source can leave the active state. Do not run a write command in the source task.

If the host cannot create a top-level task or expose authoritative task/transcript identity, stop and ask the user to create a new top-level task manually. Do not guess.

## Start from another top-level task

Use this mode when the user invokes Session Cleanup outside the target task and supplies a concrete target task/session ID.

1. Confirm the current task is a root task, its task ID equals its session ID, `forkedFromId` is absent, and its host matches the target task's host. Reject the current task as a worker if its ID equals the target ID.
2. Confirm the target ID, host, and status with Codex task tools. Resolve the target transcript with the `resolve` command above, applying the format-aware identity rules above. Resolve the current worker transcript by its own task ID the same way, and require distinct real paths.
3. Use the current task as the cleanup task. Do not create a third task. Continue with the common cleanup workflow below.

If the target is on another host or either identity cannot be established authoritatively, stop without writing.

## Run in the cleanup task

1. Confirm the worker/root identity rules above. Use Codex task tools to inspect the source status. Wait in bounded intervals until it is `idle` or `notLoaded`. Treat `active`, `inProgress`, missing, and unknown states as write blockers.
2. Inspect:

   ```text
   node "<session-cleanup-dir>/scripts/session_cleanup.mjs" inspect "<source-jsonl>"
   ```

3. Prepare the transaction without changing the source:

   ```text
   node "<session-cleanup-dir>/scripts/session_cleanup.mjs" prepare "<source-jsonl>" "<source-task-id>"
   ```

   Require a raw backup, SHA256 sidecar, prepared manifest, index entry, and cleaned staging copy.

4. Check the source again with Codex task tools. Require `idle` or `notLoaded`, then create a fresh state attestation from the observed host metadata:

   ```text
   node "<session-cleanup-dir>/scripts/session_cleanup.mjs" attest "<manifest>" "<idle-or-notLoaded>" "<worker-task-id>" "<worker-session-id>" root "<worker-transcript-jsonl>" none
   ```

5. Commit only with that fresh attestation:

   ```text
   node "<session-cleanup-dir>/scripts/session_cleanup.mjs" commit "<manifest>" "<attestation>"
   ```

6. Check the source a third time. Again require `idle` or `notLoaded` and create another attestation. In a new Node process, run the independent verifier:

   ```text
   node "<session-cleanup-dir>/scripts/verify_cleanup.mjs" "<manifest>" "<post-commit-attestation>"
   ```

7. Report success only when the verifier returns `status: verified`. Use its before/after bytes, retained unique-image count, replaced duplicate count, exact backup paths, and restart instruction for the completion response.

## Recover an interrupted transaction

When `prepare` reports a non-empty staging directory, resolve the exact earlier transaction from the staging filename and `index.jsonl`; require one matching manifest for the same source task and real path.

- If its status is `prepared` and the source fingerprint is unchanged, resume that transaction at the pre-commit status check. Do not prepare a duplicate transaction.
- If its status is `commit-intent-recorded`, obtain a fresh `idle` or `notLoaded` attestation. Rerun `commit` when the source still matches the original fingerprint; run the independent verifier when the source SHA256 already equals the cleaned SHA256. Both paths reconcile the recorded intent before continuing.
- If its status is `rollback-failed`, obtain a fresh `idle` or `notLoaded` attestation and run `rollback <manifest> <attestation>` to retry the already-verified raw backup restore.
- If its status is `prepared` and the source fingerprint changed, run `abort <manifest>`. Require `sourceWritePerformed: false`, `rawBackupPreserved: true`, and `stagingEmpty: true`, then restart from `inspect`. This abort only discards the stale derived staging copy and releases its transaction lock; it preserves the raw backup, SHA256 sidecar, manifest, and index.
- Stop without deleting anything when the staging entry cannot be matched uniquely or the source matches neither the recorded original nor cleaned SHA256.

## Completion response

Write in the user's language using exactly one matching form:

- Verified cleanup: verification result, before/after bytes, retained unique-image count, replaced duplicate count, and exact raw backup/manifest/index paths. For Chinese, end exactly with `请完全退出并重启 Codex，然后重新打开已清理的任务。`; for another language, translate that instruction naturally.
- Stopped before source write: stop reason and raw backup path when one exists. For Chinese, end exactly with `无需重启 Codex。`; for another language, translate that statement naturally.
- Verified rollback: failure reason, restored result, and raw backup path. For Chinese, end exactly with `无需重启 Codex。`; for another language, translate that statement naturally.
- Unverified rollback: failure reason, raw backup path, then the required manual recovery action.

Limit the response to the selected form.
