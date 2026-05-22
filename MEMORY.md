# Project Memory

This file records durable project operating context for future agents. It should
not be used as a daily changelog. Session-specific handoffs, reviews, and
milestones belong in dated documents under `docs/`.

## Stable Branch Discipline

- Treat `prod/stable` as the protected working baseline.
- Before edits, merges, pushes, or branch-sensitive work, inspect:
  - `git branch --show-current`
  - `git status --short --branch`
  - `git diff --stat`
  - `git log --oneline --decorate -n 10`
- Do not use `git add .`; stage only explicit files.
- Do not force push, hard reset, clean, branch-delete, or destructively remove
  files without explicit confirmation.
- Pushes require explicit user confirmation.

## Local-Only UserAuth Artifact

- `Plugin/UserAuth/code.bin` is local-only user/runtime state.
- Do not restore, stage, commit, push, inspect for content, or normalize it
  unless the user explicitly changes this policy.
- If it is the only worktree change, treat the worktree as clean enough for
  source work while keeping it isolated.

## Branch Absorption Policy

- Do not merge old, duplicate, stale, backup, or mixed branches wholesale.
- Prefer split-review and smallest viable cherry-picks.
- Reject branch intake when it:
  - is patch-equivalent to current `prod/stable`.
  - reintroduces superseded implementations.
  - deletes accepted current work.
  - mixes unrelated subsystems.
  - includes local runtime state, secrets, user artifacts, or generated churn.
- Do not absorb generated `AdminPanel-Vue/dist` churn unless it is an intentional
  frontend release artifact.

## AdminPanel Architecture

- The current admin frontend is `AdminPanel-Vue`.
- Do not restore or extend legacy `AdminPanel/js` modules as the primary UI
  surface.
- New admin UI work should be implemented natively in `AdminPanel-Vue`.
- `adminServer.js` can mount lightweight local admin modules from `routes/admin`.
- Main `server.js` and independent `adminServer.js` may have different route
  responsibilities; verify actual mounting before assuming availability.

## Codex Memory Surface

- `CodexMemoryBridge` is the policy gate for normal Codex memory writes.
- Current observability backend is `GET /admin_api/codex-memory/overview` via
  `routes/admin/codexMemory.js`.
- The current Vue AdminPanel does not have a native Codex Memory monitoring page
  until one is explicitly implemented.
- Do not restore `AdminPanel/js/codex-memory-monitor.js`.
- Runtime recall audit in `RAGDiaryPlugin` is a high-risk candidate and should
  be integrated only behind explicit gates, targeted tests, and log-safety
  review.
- Adaptive recall tuning should default to disabled until runtime audit behavior
  is proven safe.

## AI Image Agent Boundary

- AI image agent work is currently production-safe only as dry-run planning and
  inspection.
- `Plugin/AIGentStyle`, `Plugin/AIGentQuality`, and
  `Plugin/AIGentOrchestrator` must not perform real generation, real training,
  external model inspection, automatic retry execution, or persistent audit
  writes unless a future stage explicitly enables and validates those paths.
- Real execution requires explicit environment gates, request-level confirmation,
  output-directory controls, audit review, and rollback or cleanup planning.

## Validation Expectations

- Use the narrowest relevant validation for each change.
- Do not claim full validation unless it actually ran.
- Existing broad Node test command:
  - `npm test`
- Relevant targeted commands include:
  - `npm run test:photo-studio`
  - `npm run test:dingtalk-cli`
- For docs-only changes, at minimum inspect the diff and run `git diff --check`.

## Durable Reference Docs

- `docs/UNMERGED_BRANCH_ABSORPTION_REVIEW_20260426.md`
- `docs/LANE10_CODEX_MEMORY_INTAKE_REVIEW_20260426.md`
- `docs/CODEX_MEMORY_BRIDGE.md`
- `docs/AI_IMAGE_STAGE6_HANDOFF_20260426.md`
