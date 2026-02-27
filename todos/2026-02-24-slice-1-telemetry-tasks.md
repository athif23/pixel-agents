# Slice 1: Pi Telemetry Ingestion Tasks

## Core Implementation

### 1. Create PiAdapter
- [x] Create `src/runtime/piAdapter.ts`
- [x] Implement `RuntimeRecordProcessor` interface
- [x] Parse pi telemetry JSONL format
- [x] Normalize events to `RuntimeEvent` format
- [x] Tool name mapping (lowercase pi tools)
- [x] Handle agent_start, agent_end, tool_start, tool_end events

### 2. Create Pi Telemetry Watcher
- [x] Create `src/piTelemetryWatcher.ts`
- [x] Watch `~/.pi/agent/pixel-agents/` directory
- [x] Implement append-only JSONL reading with line buffering
- [x] Integrate with PiAdapter
- [x] Handle file creation/deletion

### 3. Create Pi Telemetry Parser
- [x] **SKIPPED** — PiAdapter handles parsing (processRecord method)

### 4. Extend Agent Manager for Pi Launch
- [x] Modify `src/agentManager.ts`
- [x] Add `launchNewPiTerminal()` function
- [x] Generate session ID for pi
- [x] Launch: `pi -e <extension-path> --session-id <uuid>`
- [x] Register expected pi telemetry file path
- [x] Add runtime mode parameter to control launch behavior

### 5. Runtime Mode Selection
- [x] Modify `src/PixelAgentsViewProvider.ts`
- [x] Add runtime mode setting/command
- [x] Support: `claude-only`, `dual-read-claude-authoritative`, `pi-authoritative`
- [x] Store mode preference
- [x] Switch mode at runtime

### 6. Integration
- [x] Wire PiAdapter into orchestrator
- [x] Connect pi telemetry watcher to orchestrator
- [ ] Ensure dual-read mode works (both adapters active) - deferred to Slice 2
- [x] Mode switching logic

## Testing & Quality

### 7. Build & Type Check
- [x] `npm run build` passes
- [x] TypeScript check passes
- [x] Lint passes (warnings only, no errors)

### 8. Manual Testing
- [ ] Test pi-authoritative mode
- [ ] Test claude-only mode (regression)
- [ ] Test dual-read mode - deferred to Slice 2
- [ ] Verify tool animations work
- [ ] Verify status labels appear

### 9. Documentation
- [x] Update plan status to completed
- [x] Mark checklist items done

## Post-Slice
- [ ] Commit changes
- [ ] Update master plan (mark Slice 1 complete)
- [ ] Prepare for Slice 2
