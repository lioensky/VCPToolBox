# VCPToolBox Governance Run State

Status: active branch governance follow-up.
Workspace: `A:/VCP/VCPToolBox-prod-stable`.
Current branch: `main`.
Worktree status at last check: clean.

Current verified heads and sync state:

- Latest verified `origin/main`: `e8b0c1de621bb2353e073eff8f3d8a14422b1bb0`.
- At the latest N2 read-only refresh start, local `main` was `dc8beb4`.
- Ahead/behind at latest N2 read-only refresh start: `2 / 0`.
- Recheck local `HEAD` before any approved push because each local evidence
  commit advances the local-only head.
- Push remains an A5 remote-write boundary requiring explicit approval.
- `prod/stable` / `origin/prod/stable`: `a1870b398fc82eb34c5764a9c60de9e127548494`.
- `origin/codex/absorb-upstream-main-20260526` is an ancestor of `origin/main`.

Important worktrees:

- `A:/VCP/VCPToolBox`: dirty `feature/latest-updates`, not latest main.
- `A:/VCP/VCPToolBox-photo-studio-next`: clean after Package R2 stash.
- `A:/VCP/VCPToolBox-staging-custom-integration`: removed.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`: removed from Git worktree registry, then raw-deleted after explicit approval because Windows long paths had blocked normal deletion.

Preserved local state:

- `stash@{0}`: Package R3 detached preflight dist snapshot.
- `stash@{1}`: Package R2 photo-studio-next dirty tail.

Running local services:

- Main test service on port `6005`: stopped.
- Admin test service on port `6006`: stopped.
- Existing unrelated service: port `3000`, left untouched.

Hard rules:

- `main` is the most advanced/latest integration branch.
- `prod/stable` is the stable production line and must never be deleted.
- Do not delete worktrees, branches, runtime files, or remote refs without explicit approval.

2026-05-26 branch governance follow-up:

- Read-only branch classification completed after `origin/main` was pushed to `b5fd3a3`.
- Remote branches already merged into `origin/main` include the 2026-05-26 absorb branch, prod-stable codex branches, gov-patch branches, photo-studio p0-p7 branches, `origin/feature/ai-image-agent-clean-pr`, `origin/prod/stable`, and `origin/revert/pr-35-identity-evidence-20260430`.
- Remote branches still not merged into `origin/main`: old `backup-*`, `custom*`, `feature-2026-04-19`, `feature/latest-updates`, `feature/photo-studio-guide-contract-migration`, `feature/photo-studio-next-guide-contract`, and old `safe-upstream-main-*` lines.
- These unmerged remote branches are hundreds of commits behind current `main`; do not absorb them wholesale.
- Next remote cleanup or branch deletion requires explicit approval.

2026-05-26 remote cleanup execution:

- User approved deleting the explicitly listed remote cleanup package.
- Preflight count correction: the explicit list contained 31 branches, not 32.
- Deleted those 31 merged remote branches with `git push origin --delete`.
- Verified all 31 deleted refs are absent after `git fetch origin --prune`.
- Verified protected/excluded refs still exist: `origin/main`, `origin/prod/stable`, `origin/codex/photo-studio-baserow-provider-batch`, `origin/feature/ai-image-agent-clean-pr`, and `origin/feature/latest-updates`.

2026-05-26 local cleanup execution:

- User approved deleting `backup/absorb-upstream-main-20260526-merge` and `feature/ai-image-agent-clean-pr`.
- Deleted both with ordinary `git branch -d`.
- Verified both local refs are absent.
- Verified `main` remains synchronized with `origin/main` and worktrees are unchanged.

Remaining local branch classification:

- Protected: `prod/stable`.
- Worktree-occupied: `feature/latest-updates`, `integration/latest-updates-selective-absorb`, `lane10-codex-memory-intake-20260425`, `codex/photo-studio-baserow-provider-batch`.
- Duplicate local heads requiring explicit deletion policy: `feature/ai-image-pipeline-dgp-refactor`, `feature/ai-image-pipeline-dgp-v2`, and `rescue/ai-image-pipeline-mixed-20260427_195303` all point to `546b684`; they are not ancestors of `main`.
- Patch-equivalent/topology-only candidate: `governance/origin-main-topology-bridge-preview` has no positive cherry delta but is not an ancestor of `main`; ordinary `git branch -d` is expected to refuse.
- Substantive unmerged local branches: `feature/photo-studio-guide-contract-migration`, `feature/photo-studio-next-guide-contract`, and `integration/main-absorb-prod-stable-upstream-20260525`.

Remaining remote branch classification:

- Only these remote refs are merged into `origin/main`: `origin/codex/photo-studio-baserow-provider-batch`, `origin/feature/ai-image-agent-clean-pr`, `origin/main`, and `origin/prod/stable`.
- `origin/codex/photo-studio-baserow-provider-batch` and `origin/feature/ai-image-agent-clean-pr` were intentionally retained because local branches still track them.
- Unmerged old remote lines remain: `origin/backup-*`, `origin/custom*`, `origin/feature-2026-04-19`, `origin/feature/latest-updates`, `origin/feature/photo-studio-guide-contract-migration`, `origin/feature/photo-studio-next-guide-contract`, and `origin/safe-upstream-main-*`.
- These unmerged old remote lines have positive cherry deltas and hundreds of file differences; treat them as archival/retention decisions, not cleanup-by-merge candidates.
- Branch retention policy packages are documented in `docs/governance/BRANCH_RETENTION_POLICY_PACKAGES_20260526.md`.

EP1 local duplicate label cleanup:

- User approved pushing the execution package document, then executing EP1.
- Pushed `1ca9cb0` to `origin/main`.
- Deleted local branches `feature/ai-image-pipeline-dgp-refactor` and `feature/ai-image-pipeline-dgp-v2` with `git branch -D`.
- Retained `rescue/ai-image-pipeline-mixed-20260427_195303` as the local label for `546b684`.
- Verified only the rescue label remains for `546b684`.

EP2/EP3 policy continuation:

- EP2 remains a prepared no-op by recommendation: retain `governance/origin-main-topology-bridge-preview` unless a stricter local branch list is desired.
- EP3 documents old unmerged remote line heads and recommends retaining them as archive refs for now.
- No EP2 deletion, EP3 remote rename, or EP3 remote deletion has been performed.

P1 worktree audit:

- `A:/VCP/VCPToolBox` remains dirty and protected; expanded dirty count observed as 261 entries.
- `integration/latest-updates-selective-absorb` worktree is clean and patch-equivalent to `main`; it is an optional cleanup candidate only after explicit worktree removal approval.
- `lane10-codex-memory-intake-20260425` worktree is clean but has positive cherry commits; retain pending feature/archive review.
- `codex/photo-studio-baserow-provider-batch` worktree is clean but has positive cherry commits and is ahead of its upstream; retain pending feature/archive review.

P4 local unmerged branch audit:

- `feature/photo-studio-guide-contract-migration` and `feature/photo-studio-next-guide-contract` remain broad historical feature/archive labels; do not merge wholesale.
- `integration/main-absorb-prod-stable-upstream-20260525` remains a historical governance label; current `main` has newer governance evidence, but this branch is not patch-equivalent by `git cherry`.
- No P4 deletion or merge was performed.

Current governance closure:

- Remaining branches/worktrees are classified in `docs/governance/BRANCH_RETENTION_POLICY_PACKAGES_20260526.md`.
- No unclassified cleanup candidate remains.
- Remaining possible actions are explicit decisions only: P1B optional worktree cleanup, EP2 optional topology branch deletion, EP3 optional remote archive/delete policy, or separate dirty worktree backup/retention work.

Residual merged remote cleanup:

- Deleted `origin/feature/ai-image-agent-clean-pr` after explicit user approval.
- Verified it was merged into `origin/main`, had no local tracking branch, and is absent after `git fetch origin --prune`.
- Verified `main` and `prod/stable` remain synchronized with their origin refs.

P1B cleanup execution:

- Removed `A:/VCP/VCPToolBox/.agent_board/worktrees/latest-updates-selective-absorb`.
- Deleted local branch `integration/latest-updates-selective-absorb` after explicit approval to use `git branch -D` for the patch-equivalent non-ancestor branch.
- Verified the worktree path and local branch are absent.

Dirty worktree read-only refresh:

- `A:/VCP/VCPToolBox` remains on `feature/latest-updates` at `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`.
- It is ahead/behind `origin/feature/latest-updates` by `10/15`.
- Dirty entries increased to `260`: `41` tracked and `219` untracked.
- It contains unresolved conflict markers in external sync files and secret-like patterns in config examples.
- No file in that dirty worktree was edited, deleted, moved, reset, cleaned, or checked out during the refresh.
- Next safe local action is a preservation manifest; destructive cleanup, copying secrets/runtime data, branch changes, and remote writes remain hard-stop actions.

Dirty worktree strategy package:

- Drafted `docs/governance/DIRTY_WORKTREE_STRATEGY_PACKAGES_20260526.md`.
- Direct source absorption from `A:/VCP/VCPToolBox` is closed by default after C1-C6.
- Remaining actions are explicit packages only: path-only preservation, archive planning, cleanup planning, or future rewrites D4A-D4F based on current `main`.
- No dirty worktree file was touched while drafting the strategy package.

D4B OneBot operational docs repair:

- Corrected `Plugin/vcp-onebot-adapter/.env.example` to use `/internal/channelHub/events`.
- Added README troubleshooting guidance that rejects stale `/internal/channel-hub/events`.
- Recorded the D4B execution in `docs/governance/DIRTY_WORKTREE_STRATEGY_PACKAGES_20260526.md`.
- Ran `npm test` in `Plugin/vcp-onebot-adapter`; all 12 tests passed.
- No content was copied from the dirty worktree.

D4C interaction middleware documentation intake:

- Added `docs/INTERACTION_MIDDLEWARE.md` from current `main` source facts.
- Linked it from `docs/DOCUMENTATION_INDEX.md`.
- Recorded D4C execution in `docs/governance/DIRTY_WORKTREE_STRATEGY_PACKAGES_20260526.md`.
- Ran `node --test tests/channelHub-hardening.test.js`; all 20 tests passed.
- No content was copied from the dirty worktree.

D4E CodexMemoryBridge i18n/API-contract review:

- Rejected direct intake of the dirty `.new.js` i18n variant.
- Documented that knowledge writes store under `dailynote/Codex的知识/` while returning `targetDiary=Codex knowledge`.
- Added regression assertions for the current `targetDiary` and `reason` fields.
- Ran Codex memory bridge/e2e/MCP/admin tests; all 12 tests passed.
- No content was copied from the dirty worktree.

Post-D4 next-decision package push/sync closure:

- User explicitly requested `push` after the post-D4 next-decision package was
  already present on `origin/main`.
- Preflight verified `main` was clean, `HEAD` and `origin/main` were both
  `e8b0c1de621bb2353e073eff8f3d8a14422b1bb0`, and
  `HEAD...origin/main = 0 / 0`.
- Ran `git push origin main`; Git reported `Everything up-to-date`.
- Post-check reverified `HEAD` and `origin/main` still match at
  `e8b0c1de621bb2353e073eff8f3d8a14422b1bb0`, ahead/behind remains `0 / 0`,
  and the control worktree is clean.
- No tag, release, deploy, branch deletion, dirty worktree cleanup, live
  DingTalk/MCP/DWS command, or production write was performed.

Post-sync local plan-state refresh:

- Rechecked current `main`, status, ahead/behind, log, and N1-N5 decision
  package after committing `6db847b`.
- Verified the control worktree was clean before the refresh.
- Verified local `main` is ahead of `origin/main` by `1 / 0`.
- Updated `docs/governance/POST_D4_GOVERNANCE_NEXT_DECISIONS_20260526.md` to
  replace stale `0d6c210` state with current `origin/main=e8b0c1d` and
  local-only checkpoint head `6db847b`.
- No push, tag, release, deploy, branch deletion, dirty worktree cleanup, live
  DingTalk/MCP/DWS command, or production write was performed.

N2 dirty worktree read-only refresh:

- Rechecked `A:/VCP/VCPToolBox` without editing, deleting, moving, stashing,
  resetting, cleaning, copying, or archiving any file.
- Dirty worktree remains on `feature/latest-updates` at
  `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`.
- Dirty worktree remains ahead/behind `origin/feature/latest-updates` by
  `10 / 15`.
- Dirty status remains `260` entries: `41` tracked and `219` untracked.
- Tracked dirty shape remains `28` modified-like entries and `13`
  deleted-like entries.
- Filename-only risk scan found `4` files with conflict markers and `73` files
  matching secret/config-like patterns.
- No dirty worktree file was touched, and no remote write or production action
  was performed.

D4F Noir Architect new-agent proposal:

- Reviewed current `main` Agent discovery and admin Agent file behavior.
- Verified `Agent/Noir Architect.txt` is absent from current `main` and present only as an untracked dirty-worktree candidate.
- Added `docs/governance/NOIR_ARCHITECT_AGENT_PROPOSAL_20260526.md`.
- Decision: do not add or enable the candidate automatically; future adoption requires a dedicated user-facing capability package.
- No Agent prompt body was copied from the dirty worktree.

D4D VCP panel extension product proposal:

- Reviewed current `main` admin/Agent/RAG route shape.
- Verified `vcp-panel-extension/**` is absent from current `main` and present only as a dirty-worktree standalone prototype.
- Added `docs/governance/VCP_PANEL_EXTENSION_PRODUCT_PROPOSAL_20260526.md`.
- Decision: do not add extension source automatically; future adoption requires a separate product package with API, auth, webview CSP, packaging, and validation decisions.
- No extension source body was copied from the dirty worktree.

D4A DingTalkTable compatibility layer:

- Reworked `Plugin/DingTalkTable` to forward legacy table actions through `Plugin/DingTalkCLI`.
- Removed direct DingTalk MCP URL/key configuration from the DingTalkTable config example.
- Updated DingTalkTable README and manifest for dry-run/gray-stage behavior.
- Added mocked no-real-write compatibility tests.
- No live DingTalk, MCP, or DWS command was executed.

Post-D4A validation hardening:

- Added `tests/dingtalk-table-compat.test.js` to the root `npm test` script.
- Root `npm test` passed with 80 tests.
- `npm run test:dingtalk-cli` passed with 18 tests.
- Test execution left no runtime dirty files in the control worktree.

Post-D4A push closure:

- User explicitly approved pushing `0d6c210` to `origin/main`.
- Pushed local `main` to `origin/main`; remote advanced from `1ee95f2` to
  `0d6c210`.
- Fetched `origin/main` after push and verified `HEAD`, `origin/main`, and
  `origin/HEAD` all point to `0d6c210226c30b46dc216b94a5079a0ffd7986b4`.
- Verified `HEAD...origin/main = 0 / 0` and the control worktree stayed clean.

Post-D4 local governance refresh:

- Control worktree remained on `main` and clean at refresh start.
- Local `main` had one local checkpoint commit ahead of `origin/main`:
  `c2b1009 docs: record d4 push closure`.
- Registered worktrees: protected dirty `A:/VCP/VCPToolBox`, clean
  `A:/VCP/VCPToolBox-photo-studio-export`, clean
  `A:/VCP/VCPToolBox-photo-studio-next`, and control
  `A:/VCP/VCPToolBox-prod-stable`.
- `A:/VCP/VCPToolBox` still has 260 dirty entries and remains
  `10 / 15` against `origin/feature/latest-updates`.
- Clean worktree branches `lane10-codex-memory-intake-20260425` and
  `codex/photo-studio-baserow-provider-batch` still have positive cherry
  deltas and are not cleanup candidates.
- Local `governance/origin-main-topology-bridge-preview` remains the only
  patch-equivalent/topology-only local branch candidate; deleting it still
  requires explicit branch-deletion approval.
- Remaining unmerged remote old lines still have positive cherry deltas; they
  remain archive/retention decisions, not merge-cleanup candidates.

Post-D4 next-decision package:

- Added `docs/governance/POST_D4_GOVERNANCE_NEXT_DECISIONS_20260526.md`.
- Clarified that next actions are N1 push local checkpoint records, N2 dirty
  worktree retention, N3 optional EP2 local topology branch, N4 remote old-line
  archive/retention, and N5 clean worktree feature-line retention.
- Updated historical baseline wording in the dirty-worktree and branch-retention
  policy docs to prevent old head hashes from being read as current state.
