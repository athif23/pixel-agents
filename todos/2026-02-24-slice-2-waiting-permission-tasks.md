# Slice 2: Waiting + Permission Correctness Tasks

## Phase 1: Telemetry Extension Permission Gating
- [x] Subscribe to `tool_call` event in pi-telemetry-extension
- [x] Add high-risk tool detection (`bash`, `write`, `edit`)
- [x] Implement `ctx.ui.confirm()` prompt before high-risk tools
- [x] Emit `permission_wait_start` before confirm
- [x] Emit `permission_wait_end` after confirm (approved or denied)
- [x] Handle denial: block tool and emit `tool_execution_end` with error

## Phase 2: PiAdapter Permission Events
- [x] Handle `permission_wait_start` → emit `PERMISSION_WAIT_START` runtime event
- [x] Handle `permission_wait_end` → emit `PERMISSION_WAIT_END` runtime event
- [x] Map to webview messages: `agentToolPermission`, `agentToolPermissionClear`
- [x] Ensure permission events work for sub-agents

## Phase 3: Waiting State from turn_end
- [x] Handle `turn_end` event → emit `agentStatus: 'waiting'` immediately
- [x] Handle `agent_end` event → emit `agentStatus: 'waiting'`
- [x] Keep timer fallback for missing events (defensive - timerManager still runs)
- [x] Clear waiting state on next `agent_start` or `tool_start`

## Phase 4: Webview Permission Handling
- [x] Verify `useExtensionMessages` handles `agentToolPermission`
- [x] Verify `useExtensionMessages` handles `agentToolPermissionClear`
- [x] Works for parent agents
- [x] Works for sub-agents (via subagentToolPermission/subagentToolPermissionClear)

## Phase 5: Quality Checks
- [x] Build passes (`npm run build`)
- [x] Type-check passes
- [x] Lint passes (224 pre-existing warnings, 0 new errors)
- [x] Manual test: permission flow for `bash` command ✓
- [x] Manual test: waiting state after tool completion ✓
