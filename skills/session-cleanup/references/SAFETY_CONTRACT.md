# Session Cleanup safety contract

Follow every gate in this document. A failed or unavailable gate stops the workflow.

## Task boundary

- Use a peer top-level Codex task. It may be created by the source task or may be an existing root task explicitly invoked with a different target task/session ID. A subagent, collaboration agent, fork, or worker inside the source task cannot unload its source.
- Require the worker task ID to differ from the source task ID, the worker task ID to equal its session ID, `forkedFromId` to be absent, the worker kind to be root, and the two transcript real paths to differ.
- Confirm the source task ID, host ID, and status with Codex task tools. Run the deterministic resolver only within that host's authoritative Codex sessions root. Accept only `<source-task-id>.jsonl` or a `rollout-...-<source-task-id>.jsonl` filename, require exactly one candidate, and require its first record to be `session_meta`. Never use latest-file, newest-mtime, or first-glob selection.
- Apply format-aware metadata validation. For `current-dual-id`, require both `payload.id` and the present `payload.session_id` to equal the authoritative task ID. For `legacy-id-only`, require `payload.id` to equal the authoritative task ID, require the `session_id` property to be absent, and require independent Codex task-tool confirmation of the same task ID and host. A present but empty, null, non-string, or different `session_id` is unsafe; it is not legacy metadata.
- Require the source and worker to be on the same host. Resolve the worker transcript by the same filename and format-aware `session_meta` rules before creating an attestation. Treat zero candidates, multiple candidates, metadata mismatch, malformed metadata, symlinks, and paths escaping the sessions root as unsafe.
- Require authoritative `idle` or `notLoaded` immediately before commit and again immediately after commit before independent verification. Treat `active`, `inProgress`, missing, and unknown states as write blockers.
- Keep each state attestation younger than 30 seconds and revalidate it immediately before source replacement. Treat a missing or stale status as unsafe.

## Image policy

- Preserve every JSON record, field, array item, object, and non-image string, including text, tool history, reasoning summaries, events, compacted records, and nested `replacement_history`.
- Recognize only `data:image/...;base64,...` candidates whose Base64 segment is at least 4096 characters and decodes strictly.
- Identify image equality globally across the whole JSONL by decoded byte length plus SHA256 of decoded bytes.
- Retain the first complete payload for every unique image. Replace only later duplicate occurrences with a digest-and-length marker.
- Preserve local paths, HTTP/HTTPS URLs, filenames, short data-URI examples, malformed candidates, and unsupported strings unchanged.
- Fail closed on malformed JSONL. Do not delete an `input_image` object or `image_url` field.

## Backup transaction

Store configuration at `<CODEX_HOME>/session-cleanup/config.json`. Use `<CODEX_HOME>/session-cleanup/backups` as the initial default only after creating it and completing a write/flush/read/delete probe. A user-selected absolute path replaces the saved default only after the same probe. A one-time absolute root may be passed as the third `prepare` argument; validate it identically and leave saved configuration unchanged. Never silently switch roots.

Before writeback, require all of the following under the configured backup root:

- an immutable raw JSONL backup;
- a SHA256 sidecar for that raw backup;
- a prepared JSON manifest containing source real path, transcript identity format, file identity, size, mtime, SHA256, tool/runtime versions, policy, and before/after counts;
- an append-only index entry;
- one cleaned staging file produced from the raw backup;
- a per-source transaction lock;
- an empty staging directory before starting the transaction.

Immediately before commit, compare source real path, device/inode identity, size, nanosecond mtime, and SHA256 with the prepared fingerprint. Abort on any difference. Persist a `commit-intent-recorded` manifest containing the expected original and cleaned SHA256 values before replacing the source. Copy verified staging to a flushed temporary file beside the source, revalidate the state attestation and source identity, then replace the source with one rename. Verify the new SHA256 and empty staging. If execution stops between source replacement and the committed manifest update, reconcile the recorded intent: a source matching the cleaned SHA256 may proceed to independent verification after a fresh state check; a source still matching the complete original fingerprint may retry commit; any other source state is unsafe. Before any rollback write, verify the raw backup against both the manifest and SHA256 sidecar; restore it through the same atomic replacement path.

If an interrupted transaction leaves staging non-empty, match its transaction ID to exactly one manifest for the same source. Resume `prepared` when the source fingerprint is unchanged. Reconcile `commit-intent-recorded` only by the original and cleaned SHA256 rules above. When a prepared source changed, abort the stale prepared transaction without writing the source: preserve its raw backup, SHA256 sidecar, manifest, and index; remove only its derived staging copy and transaction lock; record the observed source fingerprint and `sourceWritePerformed: false`. Then restart inspection and preparation from the current source. Treat an ambiguous or mismatched transaction as unsafe.

## Independent verification

Run `verify_cleanup.mjs` as a new Node process after the post-commit `idle` or `notLoaded` check. The verifier must independently establish:

- raw backup SHA256 and sidecar validity;
- cleaned source SHA256 and manifest consistency;
- equal JSONL record count;
- equal normalized non-image structure and content;
- exactly one complete payload retained for every original unique image;
- exactly `original occurrences - 1` duplicate markers per image;
- an empty staging directory.

The verifier records success in the manifest and index and releases the transaction lock. If semantic or hash verification fails after a valid state check, it restores and verifies the raw backup. A stale or invalid state proof performs no source write. If automatic rollback cannot proceed because its state proof expired, record `rollback-failed`; after a fresh authoritative state check, manual `rollback` must accept that state and complete the verified raw restore.

## Reporting

Use the user's language and follow exactly one matching completion form from `SKILL.md`. Include no material outside the selected outcome.
