# Secret Transfer Rules

These rules decide how secrets and permissions survive a session handoff.

## Categories

Record access items as one of these:

- `reference-only`: a safe reference such as an environment variable name, file path, SSH config host, CLI profile, keychain item, password manager item, or browser session.
- `plaintext-in-context`: a secret value appeared directly in the current chat/session context.
- `temporary-local-secret`: a secret appears to be stored in a temporary `.md`, `.txt`, or similar file inside the current project directory and may be deleted during migration.
- `missing-required`: the next session needs the secret or authorization, but it is not available.
- `not-needed-now`: known access exists but is not needed for the next step.

## Default Rules

- Do not write plaintext secrets by default.
- `access.md` stores safe references and usage instructions, not secret values.
- `secret-decisions.md` stores the handling decision for each sensitive item.
- System credential locations are safe references and usually do not need user confirmation:
  - SSH key paths,
  - SSH config hosts,
  - keychain items,
  - password manager items,
  - CLI profiles,
  - browser login state,
  - normal config paths.
- Obvious temporary plaintext storage inside a project directory should be treated like plaintext and escalated for user decision.

## User Decision Required

Ask the user before writing a plaintext value anywhere when:

- the secret value is present directly in the current context,
- the secret is in a temporary plaintext file inside the current project directory,
- the user asks to make a secret available to a future session,
- losing the current directory could lose the only copy of the secret.

Ask for:

1. Which secret to transfer.
2. Where to store it.
3. Whether it should remain local only.
4. Whether the target is ignored by git or otherwise untracked.
5. Whether the secret is low-sensitivity and resettable.

## Allowed Destinations With Explicit User Approval

- Handoff-local `secrets.local.md`.
- A machine-local `.env`.
- System keychain.
- Password manager.

Prefer keychain or password manager for high-sensitivity secrets.

## Reporting

Do not reprint full secret values in chat.
Use labels, purpose, source, and short fingerprints or suffixes.

For missing access, state:

- what is missing,
- why it is needed,
- what is blocked,
- how the user can provide it,
- whether there is an alternative.
