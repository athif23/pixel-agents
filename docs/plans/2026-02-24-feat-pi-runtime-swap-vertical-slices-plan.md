---
title: "feat: Pi runtime swap with vertical slices"
type: feat
status: active
date: 2026-02-24
---

# ✨ feat: Pi runtime swap with vertical slices

## Overview

This plan converts Pixel Agents from Claude transcript parsing to pi-coding-agent telemetry while preserving the existing office UX and terminal-first workflow.

**Decision:** do this as **one master plan + multiple implementation slice plans**, not one giant all-at-once implementation.

- Master plan (this file): scope, sequencing, guardrails, acceptance criteria
- Slice plans: independently shippable vertical slices with clear rollback points

## Brainstorm Context Used

Found brainstorm from **2026-02-23**: `docs/brainstorms/2026-02-23-pixel-agents-brainstorm.md`.
Using it as source of locked product/architecture decisions:

- Keep pi interactive in VS Code terminal
- Terminal = character
- Bundled telemetry extension loaded with pi
- Telemetry in append-only JSONL under `~/.pi/agent/pixel-agents/`
- Keep waiting + permission bubble behavior
- Support headless sub-agents as linked characters
- Reuse current reading/typing animation model

## Research Consolidation

### Local repository patterns (relevant anchors)

- Terminal launch currently hardcoded to Claude:
  - `src/agentManager.ts:41-52`
- JSONL watch + append-read buffering pipeline:
  - `src/fileWatcher.ts:9-74`
- Transcript parser + tool/waiting/sub-agent parsing:
  - `src/transcriptParser.ts:45-297`
- Permission and waiting timers:
  - `src/timerManager.ts:35-122`
- Extension ↔ webview message handlers:
  - `src/PixelAgentsViewProvider.ts:64-103`
  - `webview-ui/src/hooks/useExtensionMessages.ts:79-330`
- Tool-to-animation mapping:
  - `webview-ui/src/office/toolUtils.ts:1-20`
- Sub-agent character lifecycle:
  - `webview-ui/src/office/engine/officeState.ts:357-492`
- Constants centralization:
  - `src/constants.ts:1-7`
  - `webview-ui/src/constants.ts:100-102`

### Institutional learnings

- `docs/solutions/` not present in this repo (no prior solution docs to reuse).

### External research decision

Skipped external research.
Reason: strong local context + detailed brainstorm with locked decisions + this is primarily an internal architecture migration (not a new high-risk external domain like payments/security compliance).

## Problem Statement / Motivation

Current behavior depends on Claude transcript heuristics and record semantics. The pi runtime already supports structured lifecycle/tool events, which should reduce fragility and simplify waiting/permission/sub-agent state handling.

We need a migration path that is:

- Incremental
- Reversible
- Testable per slice
- Compatible with existing office UX

## Proposed Solution

Adopt a **strangler migration** with an internal runtime adapter:

- Introduce a runtime abstraction (ClaudeAdapter and PiAdapter)
- Keep current UI protocol stable where possible
- Add telemetry ingestion path for pi events
- Migrate feature-by-feature behind a runtime switch
- Default rollout through vertical slices, each with explicit rollback

## Technical Approach

### Architecture shape

Create runtime seam in backend so webview remains mostly unchanged initially.

- New files:
  - `src/runtime/types.ts` (normalized runtime events)
  - `src/runtime/claudeAdapter.ts`
  - `src/runtime/piAdapter.ts`
  - `src/runtime/runtimeOrchestrator.ts`
- Existing files to adapt:
  - `src/agentManager.ts`
  - `src/fileWatcher.ts`
  - `src/transcriptParser.ts`
  - `src/timerManager.ts`
  - `src/PixelAgentsViewProvider.ts`
  - `webview-ui/src/hooks/useExtensionMessages.ts`
  - `webview-ui/src/office/toolUtils.ts`

### Normalized telemetry contract (lock in Slice 0)

Define a versioned normalized event shape before building pi ingestion.

- Contract file: `src/runtime/types.ts`
- Required top-level fields for every normalized event:
  - `schemaVersion`
  - `runtime` (`claude` | `pi`)
  - `agentId`
  - `ts`
  - `eventType`
- Unknown/future events: log + ignore (never crash parser)

Initial normalized event table:

| eventType | Required fields | Optional fields | Source examples |
|---|---|---|---|
| `agent_start` | `agentId`, `ts` | `sessionId` | Claude/pi |
| `agent_end` | `agentId`, `ts` | `reason` | Claude/pi |
| `tool_start` | `agentId`, `toolCallId`, `toolName`, `ts` | `argsPreview`, `parentToolId` | Claude/pi |
| `tool_end` | `agentId`, `toolCallId`, `ts` | `status`, `error` | Claude/pi |
| `permission_wait_start` | `agentId`, `toolCallId`, `toolName`, `ts` | `isSubagent`, `parentToolId` | pi/bridge |
| `permission_wait_end` | `agentId`, `toolCallId`, `ts` | `isSubagent` | pi/bridge |
| `subagent_start` | `agentId`, `subagentId`, `parentToolId`, `ts` | `label` | Claude/pi |
| `subagent_end` | `agentId`, `subagentId`, `parentToolId`, `ts` | `reason` | Claude/pi |

### Runtime orchestrator state machine (lock in Slice 0)

Source of truth is backend runtime state; webview is projection only.

- `Idle`
- `ActiveClaude`
- `ActivePi`
- `Swapping` (workspace lock held)
- `FailedRollback` (fallback applied, error surfaced)

Required transitions:

- `ActiveClaude -> Swapping -> ActivePi`
- `ActivePi -> Swapping -> ActiveClaude` (manual fallback)
- `Swapping -> FailedRollback -> ActiveClaude|ActivePi`
- Reload recovery: if persisted `Swapping`, resolve atomically then emit one authoritative sync message

### Feature-flag rollout matrix

- **Mode A:** `claude-only` (default initially)
- **Mode B:** `dual-read-claude-authoritative` (pi ingested for observability only)
- **Mode C:** `pi-authoritative` (Claude path available as fallback)
- **Mode D:** `pi-default` (cutover complete)

Each slice exit criterion must name target mode transition.

### Vertical slices (recommended)

#### Slice 0 — Runtime seam + no behavior change

**Goal:** land adapter interfaces while still using Claude behavior.

- Add normalized event contract and adapter boundary
- Route current Claude JSONL parsing through ClaudeAdapter
- No user-visible behavior changes

Deliverables:

- `src/runtime/types.ts`
- `src/runtime/claudeAdapter.ts`
- `src/runtime/runtimeOrchestrator.ts`
- `docs/plans/2026-02-24-feat-pi-runtime-slice-0-foundation-plan.md` (child plan)

#### Slice 1 — pi terminal launch + telemetry ingestion

**Goal:** start pi sessions and ingest extension telemetry JSONL.

- Add pi launch command path in `src/agentManager.ts`
- Watch telemetry directory and parse append-only event lines
- Map pi lifecycle/tool events to normalized contract

Deliverables:

- `src/runtime/piAdapter.ts`
- `src/piTelemetryWatcher.ts`
- `src/piTelemetryParser.ts`
- `docs/plans/2026-02-24-feat-pi-runtime-slice-1-telemetry-plan.md`

#### Slice 2 — waiting + permission correctness

**Goal:** parity for waiting and permission bubbles with pi events.

- Replace heuristic timers where authoritative pi events exist
- Keep timer fallback for missing/late events
- Gate high-risk tools (`bash`, `write`, `edit`) with permission event handling

Deliverables:

- `src/timerManager.ts` updates
- `src/runtime/piPermissionBridge.ts`
- `docs/plans/2026-02-24-feat-pi-runtime-slice-2-waiting-permission-plan.md`

#### Slice 3 — sub-agent parity

**Goal:** visualize pi headless sub-agents and parent-child linkage.

- Add sub-agent create/update/done mapping in parser layer
- Ensure click-on-sub-agent focuses parent terminal
- Keep non-persisted sub-agent rule

Deliverables:

- `src/runtime/piSubagentMapper.ts`
- `webview-ui/src/hooks/useExtensionMessages.ts` updates
- `docs/plans/2026-02-24-feat-pi-runtime-slice-3-subagents-plan.md`

#### Slice 4 — cleanup + default switch

**Goal:** make pi path default and retire Claude-only internals.

- Feature flag flip (default pi)
- Remove dead parsing paths after soak period
- Update docs and troubleshooting guidance

Deliverables:

- `docs/plans/2026-02-24-feat-pi-runtime-slice-4-default-cutover-plan.md`
- `README.md` and command docs updates

## SpecFlow Findings Incorporated

From spec-flow analysis, this plan explicitly covers:

- Swap scope/precedence definition (workspace vs user/global)
- Mid-flight swap behavior (defer vs cancel)
- Failure UX (fallback + clear error reason)
- Concurrency control for dual-trigger swaps
- Persistence recovery after reload to avoid split-brain state

## Policy Decisions (must lock before Slice 1)

- **Scope precedence (default):** workspace setting overrides user/global setting.
- **Mid-flight swap rule (default):** defer swap until active tool execution completes; no force-cancel in v1.
- **Failure fallback (default):** if pi launch/telemetry init fails, keep current runtime active and show actionable error.
- **Concurrency rule (default):** single runtime-swap lock per workspace; first request wins, others queue/reject with message.
- **Persistence recovery (default):** on reload, resolve any pending swap atomically (apply or rollback), then emit one authoritative state update.

## Acceptance Criteria

### Functional

- [ ] Backend supports runtime adapter abstraction without breaking current Claude path (`src/runtime/types.ts`, `src/runtime/claudeAdapter.ts`)
- [ ] pi launch + telemetry ingestion works for at least one agent session (`src/agentManager.ts`, `src/piTelemetryWatcher.ts`)
- [ ] Tool activity maps to existing animation model with pi tool names (`webview-ui/src/office/toolUtils.ts`)
- [ ] Waiting state is event-correct (authoritative when provided, fallback otherwise) (`src/timerManager.ts`)
- [ ] Permission bubbles appear for high-risk tools and clear correctly (`src/timerManager.ts`, `webview-ui/src/hooks/useExtensionMessages.ts`)
- [ ] Sub-agent create/update/cleanup parity achieved (`src/transcriptParser.ts`/pi equivalent, `webview-ui/src/office/engine/officeState.ts`)

### Non-functional

- [ ] No regression in existing UI interactions (selection, follow camera, layout editing)
- [ ] Poll/watch behavior remains cross-platform reliable (Windows included)
- [ ] Logging/troubleshooting is sufficient to diagnose telemetry desync issues

### Quality gates

- [ ] Each slice has a rollback step documented
- [ ] Each slice validated manually in Extension Dev Host
- [ ] Parity test checklist executed for tool, waiting, permission, and sub-agent flows
- [ ] Lint/type-check/build pass at each slice boundary

## Success Metrics

- Waiting/permission false-positive rate is lower than Claude-heuristic baseline in manual parity runs (tracked in test checklist)
- Tool start→done UI transition median latency stays within acceptable UX bound (target: <= 500ms excluding actual tool runtime)
- Sub-agent cleanup completes quickly after terminal completion/cancel (target: <= 2s in normal path)
- Successful end-to-end pi session visualization across restart/reload cases in repeated Extension Dev Host runs

## Dependencies & Risks

### Dependencies

- Bundled pi telemetry extension availability and load path correctness
- Stable telemetry JSONL schema for required event types

### Risks

- Event schema drift between pi versions
- Split-brain state between backend and webview on partial failures
- Mid-turn runtime switching causing stuck UI states

### Mitigations

- Versioned telemetry schema with defensive parser
- Runtime lock around swap operation
- Fallback timers and explicit reset events

## Alternative Approaches Considered

1. **Single all-at-once migration**
   - Rejected: high blast radius, hard rollback, harder debugging
2. **Big-bang webview rewrite**
   - Rejected: unnecessary; current webview protocol can be preserved through adapter
3. **Continue Claude transcript-only mode**
   - Rejected: conflicts with locked brainstorm direction

## AI-Era Implementation Notes

- Use AI assistance for repetitive adapter/mapping scaffolding only
- Require human review for runtime boundary contracts and failure handling
- Keep test scripts/checklists explicit for quick AI-assisted iteration without silent regressions

## Suggested Child Plan Backlog

- [x] `docs/plans/2026-02-24-feat-pi-runtime-slice-0-foundation-plan.md` **COMPLETED**
- [x] `docs/plans/2026-02-24-feat-pi-runtime-slice-1-telemetry-plan.md` **COMPLETED**
- [x] `docs/plans/2026-02-24-feat-pi-runtime-slice-2-waiting-permission-plan.md` **COMPLETED**
- [ ] `docs/plans/2026-02-24-feat-pi-runtime-slice-3-subagents-plan.md` **NEXT**
- [ ] `docs/plans/2026-02-24-feat-pi-runtime-slice-4-default-cutover-plan.md`

## References & Research

### Internal references

- Brainstorm decisions: `docs/brainstorms/2026-02-23-pixel-agents-brainstorm.md`
- Launch/session wiring: `src/agentManager.ts:41-52`
- JSONL watch/read: `src/fileWatcher.ts:9-74`
- Transcript parser flow: `src/transcriptParser.ts:45-297`
- Timer logic: `src/timerManager.ts:35-122`
- Protocol handlers: `src/PixelAgentsViewProvider.ts:64-103`, `webview-ui/src/hooks/useExtensionMessages.ts:79-330`
- Animation tool mapping: `webview-ui/src/office/toolUtils.ts:1-20`
- Sub-agent state: `webview-ui/src/office/engine/officeState.ts:357-492`

### External references

- None (intentionally skipped for this planning pass)

## Final Recommendation

- **Do not execute all brainstorm items at once.**
- Use **vertical slices** with the master plan above and one child plan per slice.
- Start with Slice 0 immediately; it de-risks all later work while keeping behavior unchanged.
