# Slice 3 Sub-Agent Parity Tasks

## Phase 1: Telemetry Extension
- [x] Add sub-agent tracking in pi-telemetry-extension
- [x] Emit SUBAGENT_START event when Task spawns sub-agent
- [x] Emit SUBAGENT_END event when sub-agent completes/errors
- [x] Include parentToolId in events

## Phase 2: PiAdapter Handling
- [x] Add SUBAGENT_START/SUBAGENT_END runtime event types
- [x] Handle sub-agent events in piAdapter.ts
- [x] Map to webview messages (agentToolStart with Subtask: prefix)

## Phase 3: Webview Verification
- [x] Verify subagent character creation works
- [x] Verify subagent character removal works
- [x] Verify non-persisted rule (no workspace state) - already in codebase

## Phase 4: Quality Checks
- [x] Build passes
- [x] Type-check passes
- [x] Lint passes (only pre-existing warnings)
- [ ] Manual test checklist (pending)
