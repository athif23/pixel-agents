# Pixel Agents Telemetry Extension

A pi-coding-agent extension that emits structured telemetry events for the Pixel Agents VS Code extension.

## Installation

### Option 1: Global Installation (Recommended)

Copy this directory to the pi extensions folder:

```bash
mkdir -p ~/.pi/agent/extensions/pixel-agents-telemetry
cp -r pi-telemetry-extension/* ~/.pi/agent/extensions/pixel-agents-telemetry/
```

Then reload pi extensions:
```
/reload
```

### Option 2: Project-Local Installation

Copy to your project:

```bash
mkdir -p .pi/extensions/pixel-agents-telemetry
cp -r pi-telemetry-extension/* .pi/extensions/pixel-agents-telemetry/
```

### Option 3: Direct Load (Testing)

```bash
pi -e ./pi-telemetry-extension/index.ts
```

## What It Does

This extension subscribes to pi-coding-agent lifecycle events and writes them as JSONL to:

```
~/.pi/agent/pixel-agents/<session-id>.jsonl
```

Events emitted:

| Event | Description |
|-------|-------------|
| `agent_start` | Session started |
| `agent_end` | Session/turn ended |
| `tool_execution_start` | Tool execution began |
| `tool_execution_end` | Tool execution completed |
| `permission_wait_start` | High-risk tool (bash/write/edit) about to execute |

## Event Format

```json
{"type":"agent_start","sessionId":"uuid-here","timestamp":1700000000000}
{"type":"tool_execution_start","sessionId":"uuid-here","timestamp":1700000000001,"toolCallId":"call-123","toolName":"read","args":{"path":"/file.txt"}}
{"type":"tool_execution_end","sessionId":"uuid-here","timestamp":1700000000002,"toolCallId":"call-123","status":"ok"}
```

## Usage with Pixel Agents

1. Install this extension (Option 1 or 2 above)
2. In Pixel Agents VS Code extension, switch to `pi-authoritative` mode
3. Create a new agent - it will launch with `pi -e <extension-path> --session-id <uuid>`
4. Telemetry events will appear in `~/.pi/agent/pixel-agents/`
5. Pixel Agents will visualize tool activity, waiting states, and permissions

## Development

To modify the extension:

1. Edit `index.ts`
2. Run `/reload` in pi to hot-reload
3. Check `~/.pi/agent/pixel-agents/` for output

## Troubleshooting

**No telemetry files appearing:**
- Check that the extension loaded: look for `[PixelAgentsTelemetry] Extension loaded` in pi output
- Verify `~/.pi/agent/pixel-agents/` directory exists and is writable
- Check pi logs for errors

**Events not showing in Pixel Agents:**
- Ensure Pixel Agents is in `pi-authoritative` or `dual-read-claude-authoritative` mode
- Check that the session ID from pi matches the telemetry filename
- Verify the JSONL format is valid (each line is valid JSON)
