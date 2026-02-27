---
title: "feat: Pi runtime slice 1 telemetry ingestion"
type: feat
status: active
date: 2026-02-24
---

# ✨ feat: Pi runtime slice 1 telemetry ingestion

## Overview

Slice 1 adds pi terminal launch and telemetry ingestion. Goal: start pi sessions and ingest extension telemetry JSONL while keeping Claude path available as fallback.

## Scope

In scope:

- Add pi launch command alongside Claude
- Create `PiAdapter` for pi telemetry JSONL
- Add telemetry file watching for pi events
- Support `dual-read-claude-authoritative` or `pi-authoritative` runtime modes
- Keep runtime switchable (don't hardcode to one)

Out of scope:

- Waiting/permission behavioral changes (Slice 2)
- Sub-agent behavioral changes (Slice 3)
- Making pi default (Slice 4)

## Target Files

New:

- `src/runtime/piAdapter.ts`
- `src/piTelemetryWatcher.ts`
- `src/piTelemetryParser.ts`

Adapt:

- `src/runtime/types.ts` (add pi-specific event handling if needed)
- `src/runtime/runtimeOrchestrator.ts` (add mode switching support)
- `src/agentManager.ts` (add pi launch path)
- `src/PixelAgentsViewProvider.ts` (runtime mode selection)

## Proposed Changes

### 1) Pi telemetry file structure

Per brainstorm, pi telemetry location: `~/.pi/agent/pixel-agents/<session-id>.jsonl`

Session ID generated same way as Claude (uuid), stored per agent.

### 2) PiAdapter implementation

Create `src/runtime/piAdapter.ts`:

- Implements `RuntimeRecordProcessor` interface
- Normalizes pi telemetry events to common `RuntimeEvent` format
- Tool name mapping: lowercase pi tools (`read`, `write`, `edit`, `bash`, etc.)

### 3) Telemetry watcher

Create `src/piTelemetryWatcher.ts`:

- Similar pattern to existing file watching (`src/fileWatcher.ts`)
- Watch `~/.pi/agent/pixel-agents/` directory
- Handle append-only JSONL reads with line buffering
- Emit events to `PiAdapter`

### 4) Runtime mode selection

Extend orchestrator to support mode switching:

- `claude-only` (current)
- `dual-read-claude-authoritative` (read both, prefer Claude)
- `pi-authoritative` (read both, prefer pi)

For Slice 1, implement mode selection via setting/command.

### 5) Agent launch with runtime choice

Modify `src/agentManager.ts`:

- Add `launchNewPiTerminal()` alongside `launchNewTerminal()`
- Generate session ID
- Launch: `pi -e <bundled-extension-path> --session-id <uuid>`
- Register expected telemetry file path

## Acceptance Criteria

### Functional

- [ ] `src/runtime/piAdapter.ts` implements `RuntimeRecordProcessor` and normalizes pi events
- [ ] `src/piTelemetryWatcher.ts` watches pi telemetry directory and emits events
- [ ] `src/agentManager.ts` supports launching pi terminals with telemetry extension
- [ ] Runtime mode can be switched (claude-only ↔ pi-authoritative) via command/setting
- [ ] pi telemetry events appear in orchestrator's recent events log

### Quality gates

- [ ] Build passes (`npm run build`)
- [ ] Type-check passes
- [ ] Lint passes
- [ ] Manual test: pi agent creates successfully
- [ ] Manual test: pi tool events show correct animations in webview

## Test Checklist (manual)

- [ ] Switch runtime mode to `pi-authoritative`
- [ ] Create new agent (should launch pi)
- [ ] Run pi commands: `read`, `write`, `edit`, `bash`
- [ ] Verify character shows correct animation and status labels
- [ ] Verify tool start/done transitions work
- [ ] Switch back to `claude-only` mode
- [ ] Create agent (should launch Claude)
- [ ] Verify Claude still works normally

## Rollback Plan

If issues:

- Set runtime mode back to `claude-only`
- Pi adapter continues running but events are ignored (authoritative = Claude)
- Or: bypass orchestrator completely, revert to direct Claude path

## Dependencies

- pi-coding-agent installed and available in PATH
- Bundled pi telemetry extension at known path (or auto-detect)

## References

- Master plan: `docs/plans/2026-02-24-feat-pi-runtime-swap-vertical-slices-plan.md`
- Slice 0 plan: `docs/plans/2026-02-24-feat-pi-runtime-slice-0-foundation-plan.md`
- Brainstorm: `docs/brainstorms/2026-02-23-pixel-agents-brainstorm.md`
