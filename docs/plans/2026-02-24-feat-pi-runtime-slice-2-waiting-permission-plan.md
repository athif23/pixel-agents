---
title: "feat: Pi runtime slice 2 waiting + permission correctness"
type: feat
status: active
date: 2026-02-24
---

# ✨ feat: Pi runtime slice 2 waiting + permission correctness

## Overview

Slice 2 achieves parity for waiting and permission bubbles using authoritative pi events. Replace heuristic timers with event-driven state where possible.

## Scope

In scope:

- Waiting state from pi `turn_end` / `agent_end` events (authoritative)
- Permission gating for high-risk tools (`bash`, `write`, `edit`)
- Permission bubble display while waiting on confirmation
- Keep timer fallback for missing/late events (defensive)

Out of scope:

- Sub-agent behavioral changes (Slice 3)
- Making pi default (Slice 4)

## Target Files

Adapt:

- `src/runtime/piAdapter.ts` - add permission event handling
- `src/runtime/runtimeOrchestrator.ts` - emit permission webview messages
- `src/piTelemetryWatcher.ts` - ensure permission events are captured
- `pi-telemetry-extension/index.ts` - add permission gating with `ctx.ui.confirm()`
- `webview-ui/src/hooks/useExtensionMessages.ts` - handle permission messages

## Proposed Changes

### 1) Telemetry extension permission gating

Update `pi-telemetry-extension/index.ts` to intercept high-risk tool calls:

- Subscribe to `tool_call` event
- For `bash`, `write`, `edit`: call `ctx.ui.confirm()` before allowing
- Emit `permission_wait_start` before confirm, `permission_wait_end` after
- If user denies: block tool and emit `tool_execution_end` with error

### 2) PiAdapter permission events

Handle in `src/runtime/piAdapter.ts`:

- `permission_wait_start` → emit `PERMISSION_WAIT_START` runtime event
- `permission_wait_end` → emit `PERMISSION_WAIT_END` runtime event
- Map to webview messages: `agentToolPermission`, `agentToolPermissionClear`

### 3) Waiting state from turn_end

Current: timer-based waiting detection
New: `turn_end` / `agent_end` events immediately set waiting state

- `turn_end` event → emit `agentStatus: 'waiting'` to webview
- Keep timer as fallback for missing events

### 4) Webview permission handling

Ensure `useExtensionMessages` handles:

- `agentToolPermission` → show permission bubble
- `agentToolPermissionClear` → hide permission bubble
- Works for both parent agents and sub-agents

## Acceptance Criteria

### Functional

- [x] High-risk tools (`bash`, `write`, `edit`) trigger permission prompt in pi
- [x] Permission bubble appears above character while waiting
- [x] `turn_end` event immediately shows waiting bubble (no timer delay)
- [x] Timer fallback works if pi events are missing (timerManager still active)
- [x] Permission denial blocks tool execution

### Quality gates

- [x] Build passes (`npm run build`)
- [x] Type-check passes
- [x] Lint passes (224 pre-existing warnings, 0 new errors)
- [x] Manual test: permission flow for `bash` command ✓
- [x] Manual test: waiting state after tool completion ✓

## Test Checklist (manual)

- [ ] Run `bash ls -la` → see permission prompt in pi
- [ ] See permission bubble above character
- [ ] Approve → tool executes, bubble clears
- [ ] Deny → tool blocked, error shown
- [ ] Run `read package.json` → no permission prompt (safe tool)
- [ ] After tool completes → waiting bubble appears immediately

## Rollback Plan

If issues:

- Disable permission gating in telemetry extension (remove `tool_call` handler)
- Revert to timer-based waiting detection
- Keep pi telemetry ingestion working

## Dependencies

- Slice 1 foundation (runtime seam, pi adapter, watcher)
- pi-coding-agent `ctx.ui.confirm()` support

## References

- Master plan: `docs/plans/2026-02-24-feat-pi-runtime-swap-vertical-slices-plan.md`
- Slice 1 plan: `docs/plans/2026-02-24-feat-pi-runtime-slice-1-telemetry-plan.md`
- Current permission logic: `src/timerManager.ts:69-122`
- Current waiting logic: `src/timerManager.ts:35-56`
