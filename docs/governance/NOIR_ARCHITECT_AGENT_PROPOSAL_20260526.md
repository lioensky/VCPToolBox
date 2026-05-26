# Noir Architect Agent Proposal - 2026-05-26

Scope: D4F follow-up for the dirty worktree candidate
`A:/VCP/VCPToolBox/Agent/Noir Architect.txt`.

This is a governance proposal only. It does not add, enable, copy, archive,
delete, or modify any Agent prompt file.

## Verified Current State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Current `main` Agent directory contains 15 prompt files.
- Current `main` does not contain `Agent/Noir Architect.txt`.
- Current `main` has no checked-in `agent_map.json`; the admin API returns an
  empty map when the file is absent.
- Agent prompt discovery scans `.txt` and `.md` files under `Agent/`.
- Registered Agent expansion still depends on `agent_map.json` aliases.
- The admin Agent file API can create, list, read, and save Agent files under
  the configured Agent directory.

## Dirty Candidate Read-Only Check

- Dirty candidate path exists:
  `A:/VCP/VCPToolBox/Agent/Noir Architect.txt`.
- The dirty candidate is untracked in the dirty worktree.
- File size observed: `5698` bytes.
- No unresolved conflict marker was found.
- No real secret-like value was found during the targeted scan.
- The only sensitive-word hit was an instruction telling the agent to use
  redacted placeholders for secrets, tokens, passwords, database URLs, webhook
  URLs, and service accounts.

No candidate prompt body was copied into this proposal.

## Decision

Do not add `Agent/Noir Architect.txt` to `main` automatically.

Reason:

- Adding a new Agent persona is a user-facing capability change.
- The current runtime can discover prompt files and the admin API can create
  them, but adopting a new persona still needs an explicit product decision:
  name, alias, intended use, safety profile, UI/listing behavior, and whether it
  should be registered in `agent_map.json`.
- The dirty worktree remains a protected preservation object, not a source of
  direct prompt intake.

## Future Intake Requirements

If `Noir Architect` should become a supported Agent, handle it as a dedicated
package rather than copying from the dirty worktree:

1. Review the prompt text for persona scope, safety boundaries, and project fit.
2. Decide the exact file name and display name.
3. Decide whether to only list it as a prompt file or also register an alias in
   `agent_map.json`.
4. Confirm the admin Agent file editor can list and read the final file.
5. Add or update documentation that explains the current behavior without
   overclaiming automatic registration.
6. Run targeted Agent manager/admin route validation.
7. Require explicit approval before adding the prompt to `main` or pushing any
   follow-up commit.

## Validation Notes

Local checks performed for this proposal:

- Inspected `modules/agentManager.js`.
- Inspected `routes/admin/agents.js`.
- Listed current `Agent/` prompt files in `main`.
- Checked that `agent_map.json` is absent in current `main`.
- Checked the dirty candidate path existence and size.
- Ran a targeted conflict-marker and secret-like pattern scan on the dirty
  candidate path.

Not validated:

- No Agent prompt was loaded in a live server.
- No admin server was started.
- No new Agent file was created.
- No dirty worktree file was modified.
- No remote write was performed.
