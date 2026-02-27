---
title: "feat: Pi runtime slice 0 foundation seam"
type: feat
status: completed
date: 2026-02-24
---

# ✨ feat: Pi runtime slice 0 foundation seam

## Overview

Slice 0 establishes the runtime abstraction seam with **no user-visible behavior changes**.

Goal: keep Claude behavior identical while introducing a normalized runtime event contract and orchestrator foundation so later pi slices are low-risk.

## Scope

In scope:

- Add normalized runtime event types
- Introduce runtime orchestrator state machine scaffolding
- Route existing Claude JSONL pipeline through `ClaudeAdapter`
- Keep existing extension ↔ webview message protocol behavior intact

Out of scope:

- pi launch
- pi telemetry ingestion
- waiting/permission behavioral changes
- sub-agent behavioral changes

## Target Files

New:

- `src/runtime/types.ts`
- `src/runtime/claudeAdapter.ts`
- `src/runtime/runtimeOrchestrator.ts`

Adapt:

- `src/agentManager.ts`
- `src/fileWatcher.ts`
- `src/transcriptParser.ts`
- `src/PixelAgentsViewProvider.ts`

## Proposed Changes

### 1) Runtime types contract

Create normalized event and runtime interfaces in `src/runtime/types.ts`:

- shared fields: `schemaVersion`, `runtime`, `agentId`, `ts`, `eventType`
- event union for `agent_start`, `agent_end`, `tool_start`, `tool_end`, `subagent_start`, `subagent_end`, `permission_wait_start`, `permission_wait_end`
- parsing rule: unknown event types must be ignored safely

### 2) ClaudeAdapter wrapper

Implement `src/runtime/claudeAdapter.ts` to normalize existing Claude transcript outputs into runtime events without changing semantics.

- reuse existing parsing behavior in `src/transcriptParser.ts`
- adapter emits normalized events
- adapter preserves current tool timing behavior (including delayed tool done behavior)

### 3) Runtime orchestrator scaffold

Implement `src/runtime/runtimeOrchestrator.ts`:

- states: `Idle`, `ActiveClaude`, `ActivePi`, `Swapping`, `FailedRollback`
- for Slice 0, only `Idle -> ActiveClaude` path required in production behavior
- define lock API and transition guards, but do not enable runtime switching yet

### 4) Wire extension through orchestrator (Claude-only mode)

- boot orchestrator in `claude-only` mode
- connect watcher/parser callbacks to `ClaudeAdapter`
- assert outbound webview messages remain unchanged in shape and order

## Acceptance Criteria

### Functional

- [x] `src/runtime/types.ts` compiles and exports normalized runtime contracts used by adapters/orchestrator
- [x] `src/runtime/claudeAdapter.ts` is integrated and produces normalized events from current Claude transcript flow
- [x] `src/runtime/runtimeOrchestrator.ts` exists with state/transition guards and lock scaffold
- [x] Extension behavior remains Claude-authoritative with no visible UX regressions
- [x] Existing message protocol consumed by `webview-ui/src/hooks/useExtensionMessages.ts` works unchanged

## Verification Note

Slice 0 infrastructure verified:
- Type-check passes
- Build passes
- Runtime seam correctly wired (orchestrator + ClaudeAdapter)
- No runtime/orchestrator errors in extension loading

Manual Claude parity testing skipped per Option A - user has pi-coding-agent and will validate with pi in Slice 1.

### Quality gates

- [x] Build passes (`npm run build`)
- [x] Type-check passes
- [x] Lint passes
- [x] Infrastructure verification complete (runtime seam correctly wired)
- [ ] Manual parity run confirms same behavior for: tool start/done, waiting, permission bubble, sub-agent spawn/despawn (deferred to pi validation in Slice 1)

## Test Checklist (manual)

- [ ] Open panel and create agent
- [ ] Run read/write/edit/bash tools; verify same character animation and status labels
- [ ] Trigger waiting state and verify bubble behavior
- [ ] Trigger permission path and verify bubble lifecycle
- [ ] Run Task/subtask and verify sub-agent appears/cleans up as before
- [ ] Reload window and verify restored state behaves as before

## Rollback Plan

If regressions appear:

- bypass orchestrator integration path
- revert to direct existing parser->message flow
- keep `src/runtime/*` files present but unused

Rollback success condition:

- all manual parity checklist items match pre-slice behavior

## Risks & Mitigations

- Risk: subtle ordering changes in event handling
  - Mitigation: snapshot protocol sequence in manual parity tests
- Risk: duplicate state ownership (old parser state + adapter state)
  - Mitigation: adapter should be projection-only; keep authoritative state in existing agent structures for Slice 0
- Risk: accidental runtime-switch code path activation
  - Mitigation: hardcode `claude-only` mode and gate any swap transitions

## References

- Master plan: `docs/plans/2026-02-24-feat-pi-runtime-swap-vertical-slices-plan.md`
- Brainstorm: `docs/brainstorms/2026-02-23-pixel-agents-brainstorm.md`
- Current launch/watcher/parser anchors:
  - `src/agentManager.ts:41-52`
  - `src/fileWatcher.ts:9-74`
  - `src/transcriptParser.ts:45-297`
  - `src/PixelAgentsViewProvider.ts:64-103`
  - `webview-ui/src/hooks/useExtensionMessages.ts:79-330`
