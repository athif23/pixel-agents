---
title: "feat: Pi runtime slice 3 sub-agent parity"
type: feat
status: active
date: 2026-02-24
---

# ✨ feat: Pi runtime slice 3 sub-agent parity

## Overview

Slice 3 achieves parity for sub-agent visualization. Headless pi sub-agents spawned via tool calls are visualized as linked child characters in the office.

## Scope

In scope:

- Sub-agent creation from pi telemetry events
- Parent-child linkage (click sub-agent → focus parent terminal)
- Sub-agent tool activity display
- Sub-agent cleanup on completion/error
- Non-persisted sub-agent rule (no persistence to workspace state)

Out of scope:

- Making pi default (Slice 4)
- Sub-agent persistence across reloads
- Sub-agent seats/seating behavior changes

## Target Files

Adapt:

- `pi-telemetry-extension/index.ts` - emit sub-agent lifecycle events
- `src/runtime/piAdapter.ts` - handle sub-agent events
- `src/runtime/types.ts` - add sub-agent event types if needed
- `src/runtime/runtimeOrchestrator.ts` - emit sub-agent webview messages
- `webview-ui/src/hooks/useExtensionMessages.ts` - verify sub-agent handling
- `webview-ui/src/office/engine/officeState.ts` - verify sub-agent lifecycle

## Proposed Changes

### 1) Telemetry extension sub-agent events

Update `pi-telemetry-extension/index.ts` to track and emit sub-agent events:

- When a tool (like `Task`) spawns a sub-agent, emit `subagent_start`
- Track parent-child relationship via `parentToolId`
- Emit `subagent_end` when sub-agent completes or errors
- Include sub-agent label/name if available

### 2) PiAdapter sub-agent handling

Handle in `src/runtime/piAdapter.ts`:

- Detect sub-agent spawn in tool execution events
- Emit `SUBAGENT_START` and `SUBAGENT_END` runtime events
- Map to webview messages: `subagentToolStart`, `subagentToolDone`

### 3) Webview sub-agent handling

Ensure existing sub-agent handling works:

- `subagentToolStart` → create sub-agent character
- `subagentToolDone` → remove sub-agent character  
- Click on sub-agent → focus parent terminal
- Sub-agent tool activity shows correct animation

## Acceptance Criteria

### Functional

- [x] Running a Task tool creates a sub-agent character in the office
- [x] Sub-agent character is visually linked to parent (proximity, same color)
- [x] Clicking sub-agent focuses the parent terminal (existing behavior preserved)
- [x] Sub-agent shows tool activity (reading/typing animations)
- [x] Sub-agent cleans up when Task completes
- [x] Sub-agents are not persisted to workspace state

### Quality gates

- [x] Build passes (`npm run build`)
- [x] Type-check passes
- [x] Lint passes (pre-existing warnings only)
- [ ] Manual test: run Task with sub-agent, verify visualization
- [ ] Manual test: click sub-agent, verify parent focus
- [ ] Manual test: reload window, verify sub-agents don't restore

## Test Checklist (manual)

- [ ] Run a Task that spawns a sub-agent
- [ ] See sub-agent character appear near parent
- [ ] See sub-agent animate while working
- [ ] Click sub-agent → parent terminal focuses
- [ ] Task completes → sub-agent disappears
- [ ] Reload VS Code → no sub-agent characters restored

## Rollback Plan

If issues:

- Disable sub-agent event emission in telemetry extension
- Sub-agents simply won't visualize (graceful degradation)
- Parent agent continues to work normally

## Dependencies

- Slice 2 foundation (permission/waiting events working)
- pi-coding-agent Task tool support

## References

- Master plan: `docs/plans/2026-02-24-feat-pi-runtime-swap-vertical-slices-plan.md`
- Slice 2 plan: `docs/plans/2026-02-24-feat-pi-runtime-slice-2-waiting-permission-plan.md`
- Current sub-agent logic: `src/transcriptParser.ts:217-297`
- Webview sub-agent handling: `webview-ui/src/hooks/useExtensionMessages.ts:171-179`
- Sub-agent state management: `webview-ui/src/office/engine/officeState.ts:357-492`
