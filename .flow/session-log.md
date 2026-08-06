# Flow session log

<!-- /flow-check and /flow-run append session entries here. -->
2026-08-05T16:19:46Z  i1  TRIAGED→PLAN  | conf=8 risk=low size=S: hello carries allowed_cwds; cloud defaults per-runner cwd [assumed=2: Scope, Where]
2026-08-05T18:21:19Z  i13  CREATED-INTERACTIVE  | cold-start channel-history backfill + dashboard progress; PARKED in icebox on backfill depth (asked: 1, assumed: 2)
2026-08-05T19:42:19Z  i14  CREATED-REFACTOR  | boundary: app/ drops direct OV route, memory reads proxy via cloud
2026-08-05T19:42:19Z  i15  CREATED-REFACTOR  | constitution-P2: connect codes stop storing plaintext frl_ token
2026-08-05T19:42:19Z  i16  CREATED-REFACTOR  | broken-gate: app lint_cmd exits 0 on master again
2026-08-05T19:54:33Z  i2  TRIAGED→SPLIT  | 2 proposed sub-cards
2026-08-05T19:54:47Z  i3  TRIAGED→SPLIT  | 3 proposed sub-cards
2026-08-05T19:54:59Z  i4  TRIAGED→QUESTIONS  | Where, What, Verify
2026-08-05T19:55:12Z  i5  TRIAGED→QUESTIONS  | What, Dependencies
2026-08-05T19:55:26Z  i6  TRIAGED→QUESTIONS  | What, Scope
2026-08-05T19:55:37Z  i7  TRIAGED→SPLIT  | 2 proposed sub-cards
2026-08-05T19:55:50Z  i8  TRIAGED→QUESTIONS  | What, Edge
2026-08-05T19:56:01Z  i9  TRIAGED→QUESTIONS  | Dependencies, Verify
2026-08-05T19:56:27Z  i14  TRIAGED→PLAN  | conf=8 risk=low size=S: memory search/status proxied via cloud, OV root key leaves app
2026-08-05T19:56:57Z  i15  TRIAGED→PLAN  | conf=8 risk=low size=S: connect codes store hash + sealed token, no plaintext frl_ at rest
2026-08-05T19:57:23Z  i16  TRIAGED→PLAN  | conf=9 risk=low size=S: lint gate green — dead AuthLayout deleted, hook/trpc moved, ui/ carve-out
2026-08-05T22:38:25Z  i3  SPLIT-REVISED  | signing shipped, detection shipped; 2 sub-cards proposed (updater, onboarding) — awaiting confirmation
2026-08-06T09:01:48Z  i17  CREATED-INTERACTIVE  | shared channel agent mode, parked in icebox (asked: 0, assumed: 0, parked gaps: 3)
2026-08-06T09:07:31Z  i18  CREATED-INTERACTIVE  | channel-connections proxy, parked in icebox (asked: 0, assumed: 0, parked gaps: 3)
2026-08-06T09:07:31Z  i19  CREATED-INTERACTIVE  | audit log of turns, parked in icebox (asked: 0, assumed: 0, parked gaps: 3)
2026-08-06T09:33:27Z  i20  CREATED-INTERACTIVE  | first-run onboarding wizard, backlog (asked: 0, assumed: 0; split from closed i3)
2026-08-06T09:33:27Z  i1,i3,i4,i8  ARCHIVED  | closed as obsolete/shipped after code audit (i3 remainder -> i20)
2026-08-06T11:40:42Z  i21  CREATED-INTERACTIVE  | full Farol->OpenTag rename incl. repo+infra (asked: 3, assumed: 2)
2026-08-06T11:44:37Z  i21  TRIAGED→SPLIT  | 4 proposed sub-cards
2026-08-06T11:46:04Z  i21  SPLIT-REVISED  | greenfield: no migrations, hard cutover; 4 sub-cards proposed — awaiting confirmation
2026-08-06T11:48:43Z  i21  SPLIT-EXECUTED  | created 4 sub-cards: i22, i23, i24, i25
2026-08-06T11:49:24Z  EPIC-CREATED  | epic:opentag-rename (4 members i22-i25, +review card i27, tracker i26)
2026-08-06T11:54:57Z  i20  TRIAGED→PLAN  | conf=7 risk=med size=M: first-run wizard driven by pure next_step fn in core
2026-08-06T11:55:28Z  i22  TRIAGED→PLAN  | conf=8 risk=low size=S: brand-word sweep over live docs/UI/manifests, grep-gated
2026-08-06T11:56:06Z  i23  TRIAGED→PLAN  | conf=8 risk=low size=S: crate/ids/dirs rename, clean slate, compiler-gated [assumed=1: Where]
2026-08-06T11:56:38Z  i24  TRIAGED→PLAN  | conf=7 risk=low size=S: hosts cutover to opentag.farol.team, values-only [assumed=1: Where]
2026-08-06T11:57:06Z  i25  TRIAGED→PLAN  | conf=8 risk=low size=S: gh repo rename + tracker.json, redirects verified, run last
2026-08-06T11:57:10Z  i27  TRIAGED→QUESTIONS  | Dependencies (epic members open; replan when Done)
2026-08-06T11:57:22Z  i26  EPIC-REFRESHED  | 4 members in Plan Proposed, review card in Human Questions
2026-08-06T12:00:43Z  i22  STARTED  | worker iter 1 spawned (docs/brand rename)
2026-08-06T12:04:35Z  i22  BLOCKED  | worker: plan gate vs fences contradiction (needs #23 names first) cost=$1.48
2026-08-06T12:07:16Z  i23  STARTED  | worker iter 1 spawned (runner identity rename)
2026-08-06T12:08:54Z  i23  BLOCKED  | worker: PLAN Files missed CI workflow + cloud/app FAROL_ env family cost=$0.46
2026-08-06T12:09:19Z  i25  PLAN-INVALIDATED  | Scope claim false: 4 more repo refs (UI download URLs, tauri updater, release.md)
2026-08-06T12:13:49Z  i22,i23,i24,i25,i26,i27  ARCHIVED  | epic dissolved: split axis was not MECE (names cross subsystems)
2026-08-06T12:13:49Z  i28  CREATED  | single atomic Farol->OpenTag rename, verified inventory embedded
2026-08-06T12:16:12Z  i28  TRIAGED→PLAN  | conf=8 risk=med size=L: atomic 62-file rename, grep-derived manifest [assumed=2: Scope, Scope]
2026-08-06T12:17:26Z  i28  STARTED  | TDD gate engaged, phase A spawned
2026-08-06T12:35:23Z  i28  TDD-SPECS-REJECTED  | critic: KEPT filter forbids plan identifiers + stale hosts whitelisted + env family unpinned; respawn 1/1
2026-08-06T12:58:54Z  i28  BLOCKED  | test critic rejected specs 2x: KEPT filter blesses team.farol.runner (meta decision defect) cost=$7.77
2026-08-06T13:05:18Z  i28  PLAN-AMENDED  | S1 pinned to literal, S8/S9/S10 added, nits; round 3 starts from existing red specs
2026-08-06T13:14:00Z  i28  DOUBLE-DRIVE  | a second meta session spawned round-3 phase A concurrently (13:09-13:12) on the false premise that the live meta had crashed; its output was discarded, specs3 envelope corrupted
2026-08-06T13:27:01Z  i28  TDD-GATE-PASSED  | round 3 approved, 13 red examples, phase B spawned
2026-08-06T13:44:22Z  i28  BLOCKED  | acceptance subagent killed 3x (host); PR#29 open, all gates green manually cost=$18.35
2026-08-06T16:00:24Z  i28  ACCEPTANCE-GAPS  | 3 gaps: PR body contract x2 + live YC infra renamed in deploy.md
2026-08-06T16:31:38Z  i28  MERGED  | iter=2 conf=8 cost=$27.57 PR#29
