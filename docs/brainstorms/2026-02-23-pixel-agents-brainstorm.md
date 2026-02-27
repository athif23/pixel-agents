---
date: 2026-02-23
topic: pixel-agents-analysis
---

# Pixel Agents — Deep Technical Analysis + pi-coding-agent Swap Brainstorm

## Executive Summary

Pixel Agents is a VS Code extension that turns agent terminals into animated pixel art characters in a virtual office.

The original project targets **Claude Code** by tailing its transcript JSONL files; this brainstorm also captures a concrete path to swap the “agent runtime” to **pi-coding-agent** using pi’s first-class event hooks (extensions / SDK / JSON & RPC modes).

### pi-coding-agent swap (locked decisions so far)

- Keep pi interactive in a VS Code terminal (no custom chat UI)
- Terminal = character (same as original Pixel Agents)
- Pixel Agents launches pi with a bundled `-e <telemetry-extension>` so users don’t manually install anything
- Telemetry is append-only JSONL under `~/.pi/agent/pixel-agents/`
- Persistent per-agent pi sessions
- Permission gating + bubble for high-risk tools (`bash`, `write`, `edit`)
- Claude-Code-like headless sub-agents (separate pi processes) visualized as linked sub-characters
- Activity mapping (v1): reading = `read/grep/find/ls`, typing = `write/edit/bash` + text-only assistant streaming

---

## 1. Architecture Overview

### 1.1 Two-Process Architecture

Pixel Agents uses VS Code's WebviewView API, creating a strict separation between:

```
┌─────────────────────────────────────────────────────────────┐
│  EXTENSION HOST (Node.js)                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ AgentManager │  │FileWatcher   │  │TranscriptParser  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│         │                   │                   │           │
│         └───────────────────┼───────────────────┘           │
│                             ▼                               │
│                    ┌─────────────────┐                      │
│                    │ postMessage()   │◄──────────────────┐ │
│                    └─────────────────┘                   │ │
└──────────────────────────────────────────────────────────┼─┘
                                                           │
┌──────────────────────────────────────────────────────────┼─┐
│  WEBVIEW (React + Canvas 2D)                             │ │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │ │
│  │OfficeState   │  │GameLoop      │  │Renderer        │  │ │
│  │(Imperative)  │  │(rAF)         │  │(Canvas API)    │  │ │
│  └──────────────┘  └──────────────┘  └────────────────┘  │ │
│         ▲                   ▲                   ▲        │ │
│         └───────────────────┴───────────────────┘        │ │
│                      useExtensionMessages()              │ │
│                    ┌─────────────────┐                   │ │
│                    │ postMessage()   │───────────────────┘ │
│                    └─────────────────┘                     │
└────────────────────────────────────────────────────────────┘
```

### 1.2 VS Code Integration Points

**Activation** (`extension.ts`):
```typescript
export function activate(context: vscode.ExtensionContext) {
  const provider = new PixelAgentsViewProvider(context);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider)
  );
  
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SHOW_PANEL, () => {
      vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    })
  );
}
```

Uses `WebviewViewProvider` (not `WebviewPanel`) — lives in the panel area alongside terminal, survives tab switches.

---

## 2. Agent Detection & JSONL Pipeline

### 2.1 Data Source: Claude Code JSONL Transcripts

Location: `~/.claude/projects/<project-hash>/<session-id>.jsonl`

Project hash generation:
```typescript
const dirName = workspacePath.replace(/[:\\/]/g, '-');
return path.join(os.homedir(), '.claude', 'projects', dirName);
```

### 2.2 File Watching Strategy (Hybrid Approach)

```typescript
export function startFileWatching(agentId, filePath, ...): void {
  // Primary: fs.watch for immediate notifications
  try {
    const watcher = fs.watch(filePath, () => {
      readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
    });
    fileWatchers.set(agentId, watcher);
  } catch (e) {
    console.log(`fs.watch failed: ${e}`);
  }

  // Backup: poll every 2s (fs.watch is unreliable on some platforms)
  const interval = setInterval(() => {
    if (!agents.has(agentId)) { clearInterval(interval); return; }
    readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
  }, FILE_WATCHER_POLL_INTERVAL_MS); // 2000ms
  pollingTimers.set(agentId, interval);
}
```

### 2.3 Partial Line Handling

JSONL files are append-only, but writes may be partial:

```typescript
export function readNewLines(agentId, agents, ...): void {
  const agent = agents.get(agentId);
  const stat = fs.statSync(agent.jsonlFile);
  if (stat.size <= agent.fileOffset) return;

  // Read only new bytes since last read
  const buf = Buffer.alloc(stat.size - agent.fileOffset);
  const fd = fs.openSync(agent.jsonlFile, 'r');
  fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
  fs.closeSync(fd);
  agent.fileOffset = stat.size;

  // Combine with buffered partial line from previous read
  const text = agent.lineBuffer + buf.toString('utf-8');
  const lines = text.split('\n');
  
  // Save last (potentially incomplete) line for next read
  agent.lineBuffer = lines.pop() || '';

  // Process complete lines
  for (const line of lines) {
    if (!line.trim()) continue;
    processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
  }
}
```

### 2.4 Terminal Lifecycle

**Creating a new agent:**
```typescript
export function launchNewTerminal(...): void {
  const idx = nextTerminalIndexRef.current++;
  const terminal = vscode.window.createTerminal({
    name: `${TERMINAL_NAME_PREFIX} #${idx}`,
    cwd,
  });
  terminal.show();

  // Generate unique session ID for JSONL file
  const sessionId = crypto.randomUUID();
  terminal.sendText(`claude --session-id ${sessionId}`);

  // Pre-register expected JSONL file path
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  knownJsonlFiles.add(expectedFile);

  // Create agent immediately (before JSONL exists)
  const id = nextAgentIdRef.current++;
  const agent: AgentState = {
    id,
    terminalRef: terminal,
    projectDir,
    jsonlFile: expectedFile,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
  };
  
  agents.set(id, agent);
  webview?.postMessage({ type: 'agentCreated', id });

  // Poll for JSONL file to appear (1s intervals)
  const pollTimer = setInterval(() => {
    if (fs.existsSync(agent.jsonlFile)) {
      clearInterval(pollTimer);
      startFileWatching(id, agent.jsonlFile, ...);
      readNewLines(id, agents, waitingTimers, permissionTimers, webview);
    }
  }, JSONL_POLL_INTERVAL_MS); // 1000ms
}
```

### 2.5 `/clear` Detection & Terminal Adoption

When user runs `/clear` in Claude Code, a new JSONL file is created. The extension detects this via project-level scanning:

```typescript
function scanForNewJsonlFiles(...): void {
  const files = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(projectDir, f));

  for (const file of files) {
    if (!knownJsonlFiles.has(file)) {
      knownJsonlFiles.add(file);
      
      if (activeAgentIdRef.current !== null) {
        // Active agent focused → reassign to new file (/clear scenario)
        reassignAgentToFile(activeAgentIdRef.current, file, ...);
      } else {
        // No active agent → try to adopt the focused terminal
        const activeTerminal = vscode.window.activeTerminal;
        if (activeTerminal && !isTerminalOwned(activeTerminal, agents)) {
          adoptTerminalForFile(activeTerminal, file, projectDir, ...);
        }
      }
    }
  }
}
```

---

## 3. JSONL Record Parsing

### 3.1 Record Types

| Type | Subtype | Meaning |
|------|---------|---------|
| `assistant` | - | AI is responding; may contain `tool_use` blocks |
| `user` | - | User input; may contain `tool_result` blocks |
| `system` | `turn_duration` | Turn completed (reliable end signal) |
| `progress` | `agent_progress` | Sub-agent activity within Task tool |
| `progress` | `bash_progress` | Bash command actively executing |
| `progress` | `mcp_progress` | MCP tool actively executing |

### 3.2 Tool Detection Logic

```typescript
export function processTranscriptLine(agentId, line, agents, ...): void {
  const agent = agents.get(agentId);
  const record = JSON.parse(line);

  if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
    const blocks = record.message.content;
    const hasToolUse = blocks.some(b => b.type === 'tool_use');

    if (hasToolUse) {
      // Cancel waiting state — agent is active
      cancelWaitingTimer(agentId, waitingTimers);
      agent.isWaiting = false;
      agent.hadToolsInTurn = true;
      webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
      
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.id) {
          const status = formatToolStatus(block.name, block.input);
          agent.activeToolIds.add(block.id);
          agent.activeToolStatuses.set(block.id, status);
          agent.activeToolNames.set(block.id, block.name);
          
          webview?.postMessage({
            type: 'agentToolStart',
            id: agentId,
            toolId: block.id,
            status,
          });
        }
      }
      
      // Start permission timer for non-exempt tools
      if (hasNonExemptTool(blocks)) {
        startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
      }
    }
  }
  
  // Tool results — mark tools as done
  else if (record.type === 'user') {
    const content = record.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const toolId = block.tool_use_id;
          
          // If Task completed, clear its sub-agents
          if (agent.activeToolNames.get(toolId) === 'Task') {
            agent.activeSubagentToolIds.delete(toolId);
            agent.activeSubagentToolNames.delete(toolId);
            webview?.postMessage({
              type: 'subagentClear',
              id: agentId,
              parentToolId: toolId,
            });
          }
          
          agent.activeToolIds.delete(toolId);
          agent.activeToolStatuses.delete(toolId);
          agent.activeToolNames.delete(toolId);
          
          // Delay "done" message to prevent flicker from rapid tool chains
          setTimeout(() => {
            webview?.postMessage({
              type: 'agentToolDone',
              id: agentId,
              toolId,
            });
          }, TOOL_DONE_DELAY_MS); // 300ms
        }
      }
    }
  }
  
  // Turn duration — definitive turn end signal
  else if (record.type === 'system' && record.subtype === 'turn_duration') {
    cancelWaitingTimer(agentId, waitingTimers);
    cancelPermissionTimer(agentId, permissionTimers);

    // Clear any stale tool state
    if (agent.activeToolIds.size > 0) {
      agent.activeToolIds.clear();
      agent.activeToolStatuses.clear();
      agent.activeToolNames.clear();
      webview?.postMessage({ type: 'agentToolsClear', id: agentId });
    }

    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;
    webview?.postMessage({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
    });
  }
}
```

### 3.3 Tool Status Formatting

```typescript
export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read': return `Reading ${basename(input.file_path)}`;
    case 'Edit': return `Editing ${basename(input.file_path)}`;
    case 'Write': return `Writing ${basename(input.file_path)}`;
    case 'Bash': {
      const cmd = input.command || '';
      return `Running: ${cmd.length > 30 ? cmd.slice(0, 30) + '…' : cmd}`;
    }
    case 'Glob': return 'Searching files';
    case 'Grep': return 'Searching code';
    case 'WebFetch': return 'Fetching web content';
    case 'WebSearch': return 'Searching the web';
    case 'Task': {
      const desc = input.description || '';
      return desc ? `Subtask: ${desc.slice(0, 40) + '…'}` : 'Running subtask';
    }
    case 'AskUserQuestion': return 'Waiting for your answer';
    case 'EnterPlanMode': return 'Planning';
    default: return `Using ${toolName}`;
  }
}
```

### 3.4 Permission Detection

When a tool runs for >7s without new data, assume it's waiting for permission:

```typescript
export function startPermissionTimer(agentId, agents, permissionTimers, 
                                     permissionExemptTools, webview): void {
  cancelPermissionTimer(agentId, permissionTimers);
  
  const timer = setTimeout(() => {
    permissionTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (!agent) return;

    // Only flag if there are still active non-exempt tools
    let hasNonExempt = false;
    for (const toolId of agent.activeToolIds) {
      const toolName = agent.activeToolNames.get(toolId);
      if (!permissionExemptTools.has(toolName || '')) {
        hasNonExempt = true;
        break;
      }
    }

    if (hasNonExempt) {
      agent.permissionSent = true;
      webview?.postMessage({ type: 'agentToolPermission', id: agentId });
    }
  }, PERMISSION_TIMER_DELAY_MS); // 7000ms
  
  permissionTimers.set(agentId, timer);
}
```

Permission-exempt tools: `Task`, `AskUserQuestion` (these are expected to wait).

---

## 4. Extension ↔ Webview Message Protocol

### 4.1 Extension → Webview Messages

| Message Type | Payload | Purpose |
|--------------|---------|---------|
| `agentCreated` | `{ id: number }` | New agent spawned |
| `agentClosed` | `{ id: number }` | Agent removed |
| `agentSelected` | `{ id: number }` | Terminal focus changed |
| `agentToolStart` | `{ id, toolId, status }` | Tool execution started |
| `agentToolDone` | `{ id, toolId }` | Tool execution completed |
| `agentToolsClear` | `{ id }` | All tools cleared (turn end) |
| `agentStatus` | `{ id, status: 'active' \| 'waiting' }` | Agent state change |
| `agentToolPermission` | `{ id }` | Possible permission wait |
| `agentToolPermissionClear` | `{ id }` | Permission resolved |
| `subagentToolStart` | `{ id, parentToolId, toolId, status }` | Sub-agent tool started |
| `subagentToolDone` | `{ id, parentToolId, toolId }` | Sub-agent tool done |
| `subagentToolPermission` | `{ id, parentToolId }` | Sub-agent permission wait |
| `subagentClear` | `{ id, parentToolId }` | Sub-agent despawned |
| `existingAgents` | `{ agents: number[], agentMeta: {} }` | Restore on webview reload |
| `layoutLoaded` | `{ layout: OfficeLayout }` | Office layout update |
| `furnitureAssetsLoaded` | `{ catalog, sprites }` | Furniture catalog loaded |
| `floorTilesLoaded` | `{ sprites }` | Floor tile patterns |
| `wallTilesLoaded` | `{ sprites }` | Wall tile sprites |
| `characterSpritesLoaded` | `{ characters }` | Character PNG sprites |
| `settingsLoaded` | `{ soundEnabled }` | Initial settings |

### 4.2 Webview → Extension Messages

| Message Type | Payload | Purpose |
|--------------|---------|---------|
| `webviewReady` | - | Webview initialized, request data |
| `openClaude` | - | Create new terminal + agent |
| `focusAgent` | `{ id }` | Focus terminal for agent |
| `closeAgent` | `{ id }` | Close terminal for agent |
| `saveAgentSeats` | `{ seats }` | Persist seat assignments |
| `saveLayout` | `{ layout }` | Persist office layout |
| `setSoundEnabled` | `{ enabled }` | Toggle notification sound |
| `exportLayout` | - | Export layout to file |
| `importLayout` | - | Import layout from file |

---

## 5. Webview Architecture

### 5.1 State Management Strategy

**Hybrid approach for performance:**
- **React state**: UI chrome (toolbars, modals, menus)
- **Imperative class**: Game world (characters, tiles, animation)

```typescript
// Game state lives outside React — updated imperatively
const officeStateRef = { current: null as OfficeState | null };

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

function App() {
  // React state for UI only
  const [agents, setAgents] = useState<number[]>([]);
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({});
  
  // Game state is imperative, accessed via ref
  const officeState = getOfficeState();
}
```

### 5.2 Game Loop

```typescript
export interface GameLoopCallbacks {
  update: (dt: number) => void;  // seconds since last frame
  render: (ctx: CanvasRenderingContext2D) => void;
}

export function startGameLoop(canvas: HTMLCanvasElement, callbacks: GameLoopCallbacks): () => void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;  // Pixel-perfect rendering

  let lastTime = 0;
  let rafId = 0;
  let stopped = false;

  const frame = (time: number) => {
    if (stopped) return;
    
    // Cap delta time to prevent huge jumps on tab switch
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC);
    lastTime = time;

    callbacks.update(dt);
    callbacks.render(ctx);
    
    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return () => { stopped = true; cancelAnimationFrame(rafId); };
}
```

---

## 6. Character System

### 6.1 Character State Machine

```typescript
export const CharacterState = {
  IDLE: 'idle',    // Standing, random wander AI
  WALK: 'walk',    // Moving between tiles
  TYPE: 'type',    // Sitting at desk, working
} as const;

export interface Character {
  id: number;
  state: CharacterState;
  dir: Direction;           // DOWN | LEFT | RIGHT | UP
  x: number;                // Pixel position (center)
  y: number;
  tileCol: number;          // Grid position
  tileRow: number;
  path: Array<{ col, row }>; // Remaining BFS path
  moveProgress: number;     // 0-1 lerp between tiles
  currentTool: string | null; // For animation selection
  palette: number;          // 0-5 character skin
  hueShift: number;         // For duplicate skins (45-315°)
  frame: number;            // Animation frame index
  frameTimer: number;       // Time accumulator
  isActive: boolean;        // Currently working?
  seatId: string | null;    // Assigned chair
  bubbleType: 'permission' | 'waiting' | null;
  isSubagent: boolean;
  parentAgentId: number | null;
  matrixEffect: 'spawn' | 'despawn' | null;
}
```

### 6.2 State Transitions

```
TYPE (active working)
  └── agent becomes inactive ──► IDLE (start wander timer)

IDLE (inactive, standing)
  ├── agent becomes active ──► TYPE (pathfind to seat)
  └── wander timer expires ──► WALK (pick random destination)

WALK (moving)
  └── arrives at destination ──► [if active] TYPE
                                 [if inactive] IDLE (reset wander timer)
```

### 6.3 Wander AI Algorithm

```typescript
function updateCharacter(ch: Character, dt: number, walkableTiles, seats, tileMap, blockedTiles): void {
  switch (ch.state) {
    case CharacterState.IDLE: {
      ch.frame = 0;  // Static pose
      
      // If became active, pathfind to seat
      if (ch.isActive) {
        if (ch.seatId) {
          const seat = seats.get(ch.seatId);
          const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, 
                                tileMap, blockedTiles);
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
          }
        }
        break;
      }
      
      // Countdown wander timer
      ch.wanderTimer -= dt;
      if (ch.wanderTimer <= 0) {
        // Check if we've wandered enough — return to seat
        if (ch.wanderCount >= ch.wanderLimit && ch.seatId) {
          pathfindToSeat(ch);
          break;
        }
        
        // Pick random destination
        if (walkableTiles.length > 0) {
          const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
          const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, 
                                tileMap, blockedTiles);
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.wanderCount++;
          }
        }
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
      }
      break;
    }
    
    case CharacterState.WALK: {
      // Walk animation
      if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
        ch.frameTimer -= WALK_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % 4;  // 4-frame walk cycle
      }
      
      // Move toward next tile
      if (ch.path.length === 0) {
        // Arrived — snap to center
        const center = tileCenter(ch.tileCol, ch.tileRow);
        ch.x = center.x;
        ch.y = center.y;
        
        if (ch.isActive && ch.seatId) {
          const seat = seats.get(ch.seatId);
          if (ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
            ch.state = CharacterState.TYPE;
            ch.dir = seat.facingDir;
          }
        } else {
          ch.state = CharacterState.IDLE;
          ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
        }
        break;
      }
      
      // Interpolate position
      const nextTile = ch.path[0];
      ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row);
      ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;
      
      const fromCenter = tileCenter(ch.tileCol, ch.tileRow);
      const toCenter = tileCenter(nextTile.col, nextTile.row);
      const t = Math.min(ch.moveProgress, 1);
      ch.x = fromCenter.x + (toCenter.x - fromCenter.x) * t;
      ch.y = fromCenter.y + (toCenter.y - fromCenter.y) * t;
      
      if (ch.moveProgress >= 1) {
        ch.tileCol = nextTile.col;
        ch.tileRow = nextTile.row;
        ch.path.shift();
        ch.moveProgress = 0;
      }
      break;
    }
    
    case CharacterState.TYPE: {
      // Typing/reading animation
      if (ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
        ch.frameTimer -= TYPE_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % 2;  // 2-frame typing cycle
      }
      break;
    }
  }
}
```

### 6.4 Animation Selection

```typescript
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false;
  return READING_TOOLS.has(tool);
}

export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  switch (ch.state) {
    case CharacterState.TYPE:
      if (isReadingTool(ch.currentTool)) {
        return sprites.reading[ch.dir][ch.frame % 2];
      }
      return sprites.typing[ch.dir][ch.frame % 2];
    case CharacterState.WALK:
      return sprites.walk[ch.dir][ch.frame % 4];
    case CharacterState.IDLE:
      return sprites.walk[ch.dir][1];  // Standing pose
    default:
      return sprites.walk[ch.dir][1];
  }
}
```

### 6.5 Palette Diversity Algorithm

```typescript
private pickDiversePalette(): { palette: number; hueShift: number } {
  // Count how many non-sub-agents use each base palette (0-5)
  const counts = new Array(PALETTE_COUNT).fill(0) as number[];
  for (const ch of this.characters.values()) {
    if (ch.isSubagent) continue;
    counts[ch.palette]++;
  }
  
  const minCount = Math.min(...counts);
  // Pick from least-used palettes
  const available: number[] = [];
  for (let i = 0; i < PALETTE_COUNT; i++) {
    if (counts[i] === minCount) available.push(i);
  }
  
  const palette = available[Math.floor(Math.random() * available.length)];
  
  // First round: no hue shift. Subsequent rounds: random ≥45°
  let hueShift = 0;
  if (minCount > 0) {
    hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG);
  }
  
  return { palette, hueShift };
}
```

---

## 7. Rendering Pipeline

### 7.1 Z-Sorting Strategy

All renderable objects are sorted by Y position for proper depth:

```typescript
interface ZDrawable {
  zY: number;  // Y position for depth sorting
  draw: (ctx: CanvasRenderingContext2D) => void;
}

export function renderScene(ctx, furniture, characters, offsetX, offsetY, zoom, 
                            selectedAgentId, hoveredAgentId): void {
  const drawables: ZDrawable[] = [];

  // Add furniture
  for (const f of furniture) {
    drawables.push({
      zY: f.zY,  // Bottom edge of sprite
      draw: (c) => c.drawImage(getCachedSprite(f.sprite, zoom), 
                               offsetX + f.x * zoom, offsetY + f.y * zoom)
    });
  }

  // Add characters
  for (const ch of characters) {
    const spriteData = getCharacterSprite(ch, sprites);
    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    
    // Character anchor is bottom-center
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2);
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - cached.height);
    
    // Sort by bottom of tile (not center) for correct furniture interaction
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;
    
    // Add selection outline if selected/hovered
    if (selectedAgentId === ch.id || hoveredAgentId === ch.id) {
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET,  // Just before character
        draw: (c) => renderOutline(c, outlineCached, olDrawX, olDrawY, alpha)
      });
    }
    
    drawables.push({
      zY: charZY,
      draw: (c) => c.drawImage(cached, drawX, drawY)
    });
  }

  // Sort by Y (lower = in front = drawn later)
  drawables.sort((a, b) => a.zY - b.zY);

  for (const d of drawables) {
    d.draw(ctx);
  }
}
```

### 7.2 Render Passes

```
1. Clear canvas
2. Render tile grid (floor/wall base colors)
3. Render seat indicators (below furniture)
4. Build wall instances for z-sorting
5. Render scene (furniture + walls + characters, z-sorted)
6. Render speech bubbles (always on top of characters)
7. Render editor overlays (grid, selection, ghost preview)
```

### 7.3 Sprite Caching System

```typescript
// Per-zoom WeakMap cache — automatically garbage collected
const zoomCaches = new Map<number, WeakMap<SpriteData, HTMLCanvasElement>>();

export function getCachedSprite(sprite: SpriteData, zoom: number): HTMLCanvasElement {
  let cache = zoomCaches.get(zoom);
  if (!cache) {
    cache = new WeakMap();
    zoomCaches.set(zoom, cache);
  }

  const cached = cache.get(sprite);
  if (cached) return cached;

  // Create new cached canvas
  const canvas = document.createElement('canvas');
  canvas.width = sprite[0].length * zoom;
  canvas.height = sprite.length * zoom;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // Draw pixel data
  for (let r = 0; r < sprite.length; r++) {
    for (let c = 0; c < sprite[r].length; c++) {
      const color = sprite[r][c];
      if (color === '') continue;
      ctx.fillStyle = color;
      ctx.fillRect(c * zoom, r * zoom, zoom, zoom);
    }
  }

  cache.set(sprite, canvas);
  return canvas;
}
```

### 7.4 Outline Generation

```typescript
const outlineCache = new WeakMap<SpriteData, SpriteData>();

export function getOutlineSprite(sprite: SpriteData): SpriteData {
  const cached = outlineCache.get(sprite);
  if (cached) return cached;

  const rows = sprite.length;
  const cols = sprite[0].length;
  
  // Expanded grid: +2 in each dimension for 1px border
  const outline: string[][] = [];
  for (let r = 0; r < rows + 2; r++) {
    outline.push(new Array<string>(cols + 2).fill(''));
  }

  // For each opaque pixel, mark its 4 cardinal neighbors as white
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c] === '') continue;
      const er = r + 1;
      const ec = c + 1;
      if (outline[er - 1][ec] === '') outline[er - 1][ec] = '#FFFFFF';
      if (outline[er + 1][ec] === '') outline[er + 1][ec] = '#FFFFFF';
      if (outline[er][ec - 1] === '') outline[er][ec - 1] = '#FFFFFF';
      if (outline[er][ec + 1] === '') outline[er][ec + 1] = '#FFFFFF';
    }
  }

  // Clear pixels that overlap with original
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c] !== '') {
        outline[r + 1][c + 1] = '';
      }
    }
  }

  outlineCache.set(sprite, outline);
  return outline;
}
```

---

## 8. Sprite System

### 8.1 SpriteData Format

```typescript
/** 2D array of hex color strings (or '' for transparent). [row][col] */
export type SpriteData = string[][];
```

Example 16x16 sprite:
```typescript
const PLANT_SPRITE: SpriteData = [
  ['', '', '', '', '', '', '#3D8B37', '#3D8B37', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '#3D8B37', '#3D8B37', '#3D8B37', '#3D8B37', '', '', '', '', '', '', ''],
  // ... 16 rows total
];
```

### 8.2 Character Sprite Templates

Characters use palette substitution from templates:

```typescript
const _ = '';  // transparent
const H = 'hair';   // template key
const K = 'skin';   // template key
const S = 'shirt';  // template key
const P = 'pants';  // template key
const O = 'shoes';  // template key
const E = '#FFFFFF'; // eyes (fixed white)

type TemplateCell = typeof H | typeof K | typeof S | typeof P | typeof O | typeof E | typeof _;

const CHARACTER_PALETTES = [
  { skin: '#FFCC99', shirt: '#4488CC', pants: '#334466', hair: '#553322', shoes: '#222222' },
  { skin: '#FFCC99', shirt: '#CC4444', pants: '#333333', hair: '#FFD700', shoes: '#222222' },
  // ... 6 palettes
];

function resolveTemplate(template: TemplateCell[][], palette: CharPalette): SpriteData {
  return template.map((row) =>
    row.map((cell) => {
      if (cell === _) return '';
      if (cell === E) return E;
      if (cell === H) return palette.hair;
      if (cell === K) return palette.skin;
      if (cell === S) return palette.shirt;
      if (cell === P) return palette.pants;
      if (cell === O) return palette.shoes;
      return cell;
    })
  );
}
```

### 8.3 Frame Layout

Each character PNG is 112×96 pixels:
- **7 frames** × 16px wide = 112px
- **3 directions** × 32px tall = 96px

Frame order per direction:
1. walk1
2. walk2 (standing pose)
3. walk3
4. type1
5. type2
6. read1
7. read2

Direction rows:
- Row 0: down
- Row 1: up
- Row 2: right (left is generated by flip)

### 8.4 Colorization System

Two colorization modes:

**Colorize Mode** (Photoshop-style, for floors/walls):
```typescript
function colorizeSprite(sprite: SpriteData, color: FloorColor): SpriteData {
  // Grayscale → luminance → contrast → brightness → fixed HSL
  // Always produces the same hue regardless of original color
}
```

**Adjust Mode** (for furniture/character hue shifts):
```typescript
function adjustSprite(sprite: SpriteData, color: FloorColor): SpriteData {
  // Shifts original pixel HSL
  // H rotates hue (±180°)
  // S shifts saturation (±100)
  // B/C shift lightness/contrast
}
```

---

## 9. Layout & Furniture System

### 9.1 Layout Schema

```typescript
interface OfficeLayout {
  version: 1;
  cols: number;           // Grid width (max 64)
  rows: number;           // Grid height (max 64)
  tiles: TileType[];      // Flat array, row-major
  furniture: PlacedFurniture[];
  tileColors?: Array<FloorColor | null>;  // Per-tile color
}

interface PlacedFurniture {
  uid: string;            // Unique instance ID
  type: string;           // Asset ID or FurnitureType enum
  col: number;
  row: number;
  color?: FloorColor;     // Optional color override
}

interface FurnitureCatalogEntry {
  type: string;
  label: string;
  footprintW: number;
  footprintH: number;
  sprite: SpriteData;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces?: boolean;  // Laptops, monitors, etc.
  backgroundTiles?: number;      // Walkable top rows
  orientation?: string;          // 'front' | 'back' | 'left' | 'right'
  state?: string;                // 'on' | 'off'
  groupId?: string;              // For rotation/state groups
}
```

### 9.2 Tile Types

```typescript
export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  VOID: 8,    // Transparent, non-walkable
} as const;
```

### 9.3 Seat Derivation

Seats are derived from chair furniture automatically:

```typescript
export function layoutToSeats(furniture: PlacedFurniture[]): Map<string, Seat> {
  const seats = new Map<string, Seat>();
  
  // Build set of all desk tiles
  const deskTiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (entry?.isDesk) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          deskTiles.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }
  }

  // For each chair, every footprint tile becomes a seat
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (entry?.category !== 'chairs') continue;

    let seatCount = 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc;
        const tileRow = item.row + dr;

        // Determine facing direction:
        // 1) Chair orientation takes priority
        // 2) Adjacent desk direction
        // 3) Default forward (DOWN)
        let facingDir = determineFacing(entry.orientation, tileCol, tileRow, deskTiles);

        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`;
        seats.set(seatUid, {
          uid: seatUid,
          seatCol: tileCol,
          seatRow: tileRow,
          facingDir,
          assigned: false,
        });
        seatCount++;
      }
    }
  }

  return seats;
}
```

### 9.4 Furniture Z-Sorting Logic

```typescript
export function layoutToFurnitureInstances(furniture: PlacedFurniture[]): FurnitureInstance[] {
  // Pre-compute desk zY per tile so surface items sort correctly
  const deskZByTile = new Map<string, number>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry?.isDesk) continue;
    const deskZY = item.row * TILE_SIZE + entry.sprite.length;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        deskZByTile.set(key, deskZY);
      }
    }
  }

  const instances: FurnitureInstance[] = [];
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    const x = item.col * TILE_SIZE;
    const y = item.row * TILE_SIZE;
    let zY = y + entry.sprite.length;

    // Chair z-sorting: ensure characters sitting render correctly
    if (entry.category === 'chairs') {
      if (entry.orientation === 'back') {
        // Back-facing chairs render IN FRONT of seated character
        zY = (item.row + 1) * TILE_SIZE + 1;
      } else {
        // Other chairs: cap zY so characters render in front
        zY = (item.row + 1) * TILE_SIZE;
      }
    }

    // Surface items render in front of the desk they sit on
    if (entry.canPlaceOnSurfaces) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`);
          if (deskZ !== undefined && deskZ + 0.5 > zY) {
            zY = deskZ + 0.5;
          }
        }
      }
    }

    instances.push({ sprite, x, y, zY });
  }
  return instances;
}
```

### 9.5 Auto-On Electronics

Electronics (monitors, lamps) automatically turn on when an active agent faces them:

```typescript
private rebuildFurnitureInstances(): void {
  // Collect tiles where active agents face desks
  const autoOnTiles = new Set<string>();
  for (const ch of this.characters.values()) {
    if (!ch.isActive || !ch.seatId) continue;
    const seat = this.seats.get(ch.seatId);
    if (!seat) continue;
    
    // Check tiles in facing direction (3 tiles deep, 2 tiles wide)
    const dCol = seat.facingDir === Direction.RIGHT ? 1 : 
                 seat.facingDir === Direction.LEFT ? -1 : 0;
    const dRow = seat.facingDir === Direction.DOWN ? 1 : 
                 seat.facingDir === Direction.UP ? -1 : 0;
    
    for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
      const tileCol = seat.seatCol + dCol * d;
      const tileRow = seat.seatRow + dRow * d;
      autoOnTiles.add(`${tileCol},${tileRow}`);
    }
    
    // Side tiles for wide desks
    for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
      // ... add side tiles
    }
  }

  // Apply auto-on state to furniture
  const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
    const entry = getCatalogEntry(item.type);
    if (!entry) return item;
    
    // Check if any tile overlaps an auto-on tile
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
          const onType = getOnStateType(item.type);
          if (onType !== item.type) {
            return { ...item, type: onType };
          }
        }
      }
    }
    return item;
  });

  this.furniture = layoutToFurnitureInstances(modifiedFurniture);
}
```

---

## 10. Pathfinding System

### 10.1 BFS Implementation

```typescript
export function findPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  if (startCol === endCol && startRow === endRow) return [];

  const key = (c: number, r: number) => `${c},${r}`;
  const visited = new Set<string>();
  visited.add(key(startCol, startRow));

  const parent = new Map<string, string>();
  const queue: Array<{ col: number; row: number }> = [
    { col: startCol, row: startRow }
  ];

  const dirs = [
    { dc: 0, dr: -1 }, // up
    { dc: 0, dr: 1 },  // down
    { dc: -1, dr: 0 }, // left
    { dc: 1, dr: 0 },  // right
  ];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currKey = key(curr.col, curr.row);

    if (currKey === key(endCol, endRow)) {
      // Reconstruct path
      const path: Array<{ col: number; row: number }> = [];
      let k = key(endCol, endRow);
      while (k !== key(startCol, startRow)) {
        const [c, r] = k.split(',').map(Number);
        path.unshift({ col: c, row: r });
        k = parent.get(k)!;
      }
      return path;
    }

    for (const d of dirs) {
      const nc = curr.col + d.dc;
      const nr = curr.row + d.dr;
      const nk = key(nc, nr);

      if (visited.has(nk)) continue;
      if (!isWalkable(nc, nr, tileMap, blockedTiles)) continue;

      visited.add(nk);
      parent.set(nk, currKey);
      queue.push({ col: nc, row: nr });
    }
  }

  return []; // No path found
}
```

### 10.2 Walkability Check

```typescript
export function isWalkable(
  col: number,
  row: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): boolean {
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
  
  const t = tileMap[row][col];
  if (t === TileType.WALL || t === TileType.VOID) return false;
  if (blockedTiles.has(`${col},${row}`)) return false;
  
  return true;
}
```

---

## 11. Sub-Agent System

### 11.1 Sub-Agent Tracking

```typescript
interface AgentState {
  id: number;
  // ... other fields ...
  activeSubagentToolIds: Map<string, Set<string>>;    // parentToolId → sub-tool IDs
  activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
}

// In webview
class OfficeState {
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  
  private nextSubagentId = -1;  // Negative IDs for sub-agents
}
```

### 11.2 Sub-Agent Creation

```typescript
addSubagent(parentAgentId: number, parentToolId: string): number {
  const key = `${parentAgentId}:${parentToolId}`;
  if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!;

  const id = this.nextSubagentId--;  // Decrement for unique negative ID
  const parentCh = this.characters.get(parentAgentId);
  const palette = parentCh ? parentCh.palette : 0;
  const hueShift = parentCh ? parentCh.hueShift : 0;

  // Find the free seat closest to the parent agent
  const parentCol = parentCh ? parentCh.tileCol : 0;
  const parentRow = parentCh ? parentCh.tileRow : 0;
  
  let bestSeatId: string | null = null;
  let bestDist = Infinity;
  for (const [uid, seat] of this.seats) {
    if (!seat.assigned) {
      const d = Math.abs(seat.seatCol - parentCol) + Math.abs(seat.seatRow - parentRow);
      if (d < bestDist) {
        bestDist = d;
        bestSeatId = uid;
      }
    }
  }

  const ch = createCharacter(id, palette, bestSeatId, seat, hueShift);
  ch.isSubagent = true;
  ch.parentAgentId = parentAgentId;
  ch.matrixEffect = 'spawn';
  
  this.characters.set(id, ch);
  this.subagentIdMap.set(key, id);
  this.subagentMeta.set(id, { parentAgentId, parentToolId });
  
  return id;
}
```

### 11.3 Sub-Agent Permission Detection

```typescript
// In timerManager.ts
export function startPermissionTimer(...): void {
  const timer = setTimeout(() => {
    // Check parent tools for non-exempt
    let hasNonExempt = false;
    for (const toolId of agent.activeToolIds) {
      const toolName = agent.activeToolNames.get(toolId);
      if (!permissionExemptTools.has(toolName || '')) {
        hasNonExempt = true;
        break;
      }
    }

    // Check sub-agent tools for non-exempt
    const stuckSubagentParentToolIds: string[] = [];
    for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subToolNames) {
        if (!permissionExemptTools.has(toolName)) {
          stuckSubagentParentToolIds.push(parentToolId);
          hasNonExempt = true;
          break;
        }
      }
    }

    if (hasNonExempt) {
      webview?.postMessage({ type: 'agentToolPermission', id: agentId });
      
      // Also notify stuck sub-agents
      for (const parentToolId of stuckSubagentParentToolIds) {
        webview?.postMessage({
          type: 'subagentToolPermission',
          id: agentId,
          parentToolId,
        });
      }
    }
  }, PERMISSION_TIMER_DELAY_MS);
}
```

---

## 12. Asset Loading Pipeline

### 12.1 Load Order

1. `characterSpritesLoaded` → Character PNG sprites
2. `floorTilesLoaded` → Floor tile patterns
3. `wallTilesLoaded` → Wall tile sprites
4. `furnitureAssetsLoaded` → Furniture catalog + sprites
5. `layoutLoaded` → Office layout

### 12.2 PNG to SpriteData Conversion

```typescript
function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): SpriteData {
  const png = PNG.sync.read(pngBuffer);
  const sprite: string[][] = [];
  const data = png.data; // Uint8Array with RGBA values

  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * png.width + x) * 4;
      const r = data[pixelIndex];
      const g = data[pixelIndex + 1];
      const b = data[pixelIndex + 2];
      const a = data[pixelIndex + 3];

      if (a < PNG_ALPHA_THRESHOLD) {  // 128
        row.push('');  // Transparent
      } else {
        const hex = `#${r.toString(16).padStart(2, '0')}` +
                    `${g.toString(16).padStart(2, '0')}` +
                    `${b.toString(16).padStart(2, '0')}`.toUpperCase();
        row.push(hex);
      }
    }
    sprite.push(row);
  }

  return sprite;
}
```

### 12.3 Wall Auto-Tiling

Walls use 4-bit bitmask auto-tiling (16 variations):

```typescript
export interface LoadedWallTiles {
  /** 16 sprites indexed by bitmask (N=1, E=2, S=4, W=8) */
  sprites: string[][][];
}

// walls.png is 64×128 pixels
// 4×4 grid of 16×32 pieces
// Piece at bitmask M: col = M % 4, row = floor(M / 4)
```

Bitmask calculation at render time:
```typescript
function computeWallBitmask(tileMap, col, row): number {
  let mask = 0;
  if (isWall(tileMap, col, row - 1)) mask |= 1;  // N
  if (isWall(tileMap, col + 1, row)) mask |= 2;  // E
  if (isWall(tileMap, col, row + 1)) mask |= 4;  // S
  if (isWall(tileMap, col - 1, row)) mask |= 8;  // W
  return mask;
}
```

---

## 13. Matrix Spawn/Despawn Effect

```typescript
export const MATRIX_EFFECT_DURATION_SEC = 0.3;
export const MATRIX_TRAIL_LENGTH = 6;
export const MATRIX_SPRITE_COLS = 16;
export const MATRIX_SPRITE_ROWS = 24;

function renderMatrixEffect(ctx, character, spriteData, drawX, drawY, zoom): void {
  const progress = character.matrixEffectTimer / MATRIX_EFFECT_DURATION_SEC;
  
  // 16 vertical columns sweep top-to-bottom
  for (let col = 0; col < MATRIX_SPRITE_COLS; col++) {
    // Per-column random seed for staggered timing
    const seed = character.matrixEffectSeeds[col];
    const colProgress = (progress - seed * MATRIX_COLUMN_STAGGER_RANGE) / 
                        (1 - MATRIX_COLUMN_STAGGER_RANGE);
    
    if (colProgress < 0 || colProgress > 1) continue;
    
    const scanRow = Math.floor(colProgress * (MATRIX_SPRITE_ROWS + MATRIX_TRAIL_LENGTH));
    
    for (let row = 0; row < MATRIX_SPRITE_ROWS; row++) {
      const pixelY = scanRow - row;
      if (pixelY < 0 || pixelY >= MATRIX_SPRITE_ROWS) continue;
      
      const color = spriteData[pixelY][col];
      if (color === '') continue;
      
      // Trail effect: newer pixels are brighter
      const trailPos = scanRow - row;
      let alpha = 1;
      if (trailPos < MATRIX_TRAIL_LENGTH) {
        alpha = trailPos / MATRIX_TRAIL_LENGTH;
      }
      
      ctx.fillStyle = character.matrixEffect === 'spawn' 
        ? `rgba(204, 255, 204, ${alpha})`  // Green for spawn
        : `rgba(255, 100, 100, ${alpha})`; // Red for despawn
        
      ctx.fillRect(
        drawX + col * zoom,
        drawY + row * zoom,
        zoom, zoom
      );
    }
  }
}
```

---

## 14. Persistence Strategy

### 14.1 Agent Persistence

```typescript
// Stored in VS Code workspaceState (per-workspace)
interface PersistedAgent {
  id: number;
  terminalName: string;
  jsonlFile: string;
  projectDir: string;
}

const WORKSPACE_KEY_AGENTS = 'pixel-agents.agents';
const WORKSPACE_KEY_AGENT_SEATS = 'pixel-agents.agentSeats';

// Seat assignments stored separately
interface AgentSeatMeta {
  palette: number;
  hueShift: number;
  seatId: string | null;
}
```

### 14.2 Layout Persistence

```typescript
// Stored in user home directory (cross-workspace)
const LAYOUT_FILE_DIR = '.pixel-agents';
const LAYOUT_FILE_NAME = 'layout.json';
// Full path: ~/.pixel-agents/layout.json

// Atomic write pattern
export function writeLayoutToFile(layout: Record<string, unknown>): void {
  const layoutDir = path.join(os.homedir(), LAYOUT_FILE_DIR);
  const layoutPath = path.join(layoutDir, LAYOUT_FILE_NAME);
  const tempPath = `${layoutPath}.tmp`;
  
  fs.mkdirSync(layoutDir, { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(layout, null, 2), 'utf-8');
  fs.renameSync(tempPath, layoutPath);  // Atomic rename
}
```

### 14.3 Cross-Window Sync

```typescript
export function watchLayoutFile(callback: (layout) => void): LayoutWatcher {
  const layoutPath = getLayoutFilePath();
  
  // Hybrid: fs.watch + polling backup
  let lastMtime = 0;
  
  const checkFile = () => {
    try {
      const stat = fs.statSync(layoutPath);
      if (stat.mtimeMs > lastMtime) {
        lastMtime = stat.mtimeMs;
        const layout = readLayoutFromFile();
        if (layout) callback(layout);
      }
    } catch { /* ignore */ }
  };
  
  const watcher = fs.watch(layoutPath, checkFile);
  const interval = setInterval(checkFile, LAYOUT_FILE_POLL_INTERVAL_MS);
  
  return {
    markOwnWrite: () => { lastMtime = Date.now(); },
    dispose: () => { watcher.close(); clearInterval(interval); }
  };
}
```

---

## 15. Key Technical Decisions

### 15.1 Why Hybrid File Watching?

`fs.watch` is unreliable on Windows and macOS (misses events under load). The 2s polling backup ensures no missed updates at the cost of slightly delayed detection.

### 15.2 Why Imperative Game State?

React state updates caused frame drops during animation. The `OfficeState` class with direct mutation and `requestAnimationFrame` provides 60fps smooth animation.

### 15.3 Why Delay Tool Done Messages?

Claude Code often chains tools rapidly. Without the 300ms delay, tools would flash briefly causing visual noise. The delay coalesces rapid transitions.

### 15.4 Why Two Idle Detection Methods?

- `turn_duration` signal: Reliable for tool-using turns (~98% of cases)
- Text-idle timer (5s): Fallback for text-only turns where `turn_duration` is never emitted

### 15.5 Why Negative IDs for Sub-Agents?

Sub-agents are ephemeral (not persisted). Negative IDs prevent collision with main agent IDs and make debugging easier (immediately identifiable in logs).

---

## 16. Integration Opportunities with Arvis

### 16.1 Option A: Widget-Based Visualization

Create a simplified Arvis widget that shows agent presence:

```typescript
// Arvis widget type
interface PixelAgentsWidget {
  type: 'pixel_agents';
  agents: Array<{
    id: string;
    name: string;
    status: 'active' | 'waiting' | 'idle';
    currentTool?: string;
    subagents?: string[];
  }>;
}
```

**Pros**: Native Arvis integration, lightweight
**Cons**: Limited visual fidelity, no editor

### 16.2 Option B: Embed Full Webview

Host Pixel Agents React app as static files in Arvis web UI:

```typescript
// Bridge Arvis protocol to Pixel Agents format
function arvisToPixelAgentsMessage(arvisEvent): PixelAgentsMessage {
  switch (arvisEvent.type) {
    case 'task_start':
      return { type: 'agentCreated', id: arvisEvent.taskId };
    case 'tool_call':
      return { 
        type: 'agentToolStart', 
        id: arvisEvent.taskId,
        toolId: arvisEvent.toolId,
        status: formatToolStatus(arvisEvent.toolName, arvisEvent.input)
      };
    // ... etc
  }
}
```

**Pros**: Full feature parity, reuse all rendering code
**Cons**: Requires WebSocket/SSE bridge, heavier bundle

### 16.3 Option C: Inspiration Only

Adopt concepts without direct code reuse:
- Visual agent presence indicator
- Workspace/desk metaphor for different projects
- Sub-agent visualization for parallel tasks
- Playful humanizing touch

---

## 17. Replacing Claude Code with pi-coding-agent (Feasibility)

Yes — and it’s likely *more robust* than the Claude Code approach.

Pixel Agents currently infers agent activity by tailing Claude Code’s JSONL transcripts and applying heuristics (tool_use/tool_result blocks, plus a turn-end signal). Pi already exposes **structured lifecycle + tool execution events** (via Extensions, SDK subscriptions, `--mode json`, and `--mode rpc`), so you can drive animations from first-class events instead of guessing.

### 17.1 What Pixel Agents actually needs (signals)

To animate characters reliably, Pixel Agents needs a stream of:
- **Agent identity**: create/close, and a stable ID per running agent
- **Tool execution start / end**: tool name + toolCallId, optionally args
- **“Idle / waiting” transitions**: when the agent finished its turn and is awaiting user input
- (Optional) **Sub-agent** events: create/close sub-characters

Pi can provide all of these directly.

### 17.2 Integration options (recommended first)

#### Option A — Keep pi interactive in VS Code terminal + add a pi Extension that emits “telemetry” (recommended)

**How it works:**
- You still launch `pi` in a normal VS Code terminal (so the user keeps pi’s TUI workflow).
- A small pi extension subscribes to events like:
  - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
  - `turn_start` / `turn_end`
  - `agent_start` / `agent_end`
- That extension writes compact JSON lines to a known file per session/process (or emits via localhost WebSocket).
- The Pixel Agents VS Code extension watches that file/socket and maps events → character animation + bubbles.

**Why this is strong:**
- No Claude Code transcript parsing.
- No heuristics for “turn end” — you can treat `turn_end` / `agent_end` as authoritative.
- No need to fork pi (extensions are a first-class customization path).

#### Option B — Run pi in RPC mode and let the VS Code extension own the UI (most reliable, bigger scope)

**How it works:**
- Pixel Agents spawns `pi --mode rpc` as a child process per agent.
- It parses stdout JSON events (same event types as `--mode json`) and updates the office.
- It sends prompts to stdin via RPC commands.

**Tradeoff:** you likely won’t use the VS Code terminal as the chat UI anymore; you’d build a chat input in the webview (or another VS Code view).

#### Option C — Tail pi session JSONL files (simplest, but weakest realtime)

Pi sessions are JSONL and include assistant tool calls + tool results, but:
- the session file is optimized for *history* and branching, not necessarily realtime tool execution updates
- you may not get “tool started” and “tool streaming output” signals as cleanly as RPC/extension events

### 17.3 Tool name mapping changes

Pixel Agents currently maps Claude Code tool names like `Read`, `Write`, `Edit`, `Bash`, `Grep` into “reading vs typing” animations.

Pi tool names are typically lowercase (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`), plus any extension-defined tools.

So you’d update the mapping to something like:
- **Reading**: `read`, `grep`, `find`, `ls`
- **Typing**: `write`, `edit`
- **Busy**: `bash` (could animate typing or “running”)

### 17.4 Waiting / permission states

- **Waiting** is straightforward: treat `agent_end` (or `turn_end`) as “waiting for next user message”.
- **Permission bubbles**: pi doesn’t have built-in permission prompts, but pi extensions can intercept `tool_call` and ask the user to confirm. That same extension can emit a “permission wait” event that Pixel Agents visualizes.

---

## 18. Current Decisions (pi swap)

- **Keep pi interactive in VS Code terminal** (no custom chat UI).
- **Terminal = character** (matches original Pixel Agents: no reattach-to-session if the terminal/process is gone; restore only if the terminal still exists).
- **Telemetry transport:** append-only JSONL file per agent/session.
- **Telemetry location:** `~/.pi/agent/pixel-agents/` (user-level, stable).
- **Telemetry install/load:** Pixel Agents launches pi with `-e <bundled-extension-path>` so users don’t manually install anything.
- **Sessions:** persistent per agent (each character gets its own pi session file).
- **Permission gating + bubble:** yes — gate **high-risk tools** (`bash`, `write`, `edit`) via `ctx.ui.confirm()`, and show a permission bubble while waiting on that confirmation.
- **Sub-agents:** yes — Claude-Code-like headless/ephemeral subagents spawned by a tool call (separate `pi` processes), visualized as linked sub-characters; clicking a sub-character focuses the parent terminal.
- **Activity/animation mapping (v1):** reuse existing animations only.
  - **Reading animation**: `read`, `grep`, `find`, `ls`
  - **Typing animation**: `write`, `edit`, `bash` (and unknown/custom tools default to typing)
  - **Text-only assistant streaming (no tools)**: animate as typing while the agent is active (`agent_start` → `agent_end`)

## 19. Resolved Questions

- Additional signals beyond tool activity + waiting/permission: **No** (keep minimal).

---

## Appendix: Constants Reference

### Extension Constants (`src/constants.ts`)

```typescript
// Timing (ms)
JSONL_POLL_INTERVAL_MS = 1000;          // Poll for new JSONL file
FILE_WATCHER_POLL_INTERVAL_MS = 2000;   // Backup polling for changes
PROJECT_SCAN_INTERVAL_MS = 1000;        // Scan for /clear new files
TOOL_DONE_DELAY_MS = 300;               // Delay before clearing tool UI
PERMISSION_TIMER_DELAY_MS = 7000;       // Time before permission bubble
TEXT_IDLE_DELAY_MS = 5000;              // Text-only turn detection

// Display
BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// PNG Parsing
PNG_ALPHA_THRESHOLD = 128;

// Wall Tiles
WALL_PIECE_WIDTH = 16;
WALL_PIECE_HEIGHT = 32;
WALL_GRID_COLS = 4;
WALL_BITMASK_COUNT = 16;

// Floor Tiles
FLOOR_PATTERN_COUNT = 7;
FLOOR_TILE_SIZE = 16;

// Character Sprites
CHARACTER_DIRECTIONS = ['down', 'up', 'right'];
CHAR_FRAME_W = 16;
CHAR_FRAME_H = 32;
CHAR_FRAMES_PER_ROW = 7;
CHAR_COUNT = 6;
```

### Webview Constants (`webview-ui/src/constants.ts`)

```typescript
// Grid & Layout
TILE_SIZE = 16;
DEFAULT_COLS = 20;
DEFAULT_ROWS = 11;
MAX_COLS = 64;
MAX_ROWS = 64;

// Character Animation
WALK_SPEED_PX_PER_SEC = 48;
WALK_FRAME_DURATION_SEC = 0.15;
TYPE_FRAME_DURATION_SEC = 0.3;
WANDER_PAUSE_MIN_SEC = 2.0;
WANDER_PAUSE_MAX_SEC = 20.0;
WANDER_MOVES_BEFORE_REST_MIN = 3;
WANDER_MOVES_BEFORE_REST_MAX = 6;
SEAT_REST_MIN_SEC = 120.0;
SEAT_REST_MAX_SEC = 240.0;

// Matrix Effect
MATRIX_EFFECT_DURATION_SEC = 0.3;
MATRIX_TRAIL_LENGTH = 6;

// Rendering
CHARACTER_SITTING_OFFSET_PX = 6;
CHARACTER_Z_SORT_OFFSET = 0.5;
SELECTED_OUTLINE_ALPHA = 1.0;
HOVERED_OUTLINE_ALPHA = 0.5;
BUBBLE_FADE_DURATION_SEC = 0.5;

// Editor
UNDO_STACK_MAX_SIZE = 50;
LAYOUT_SAVE_DEBOUNCE_MS = 500;

// Game Logic
MAX_DELTA_TIME_SEC = 0.1;
WAITING_BUBBLE_DURATION_SEC = 2.0;
PALETTE_COUNT = 6;
HUE_SHIFT_MIN_DEG = 45;
HUE_SHIFT_RANGE_DEG = 271;
AUTO_ON_FACING_DEPTH = 3;
AUTO_ON_SIDE_DEPTH = 2;
```
