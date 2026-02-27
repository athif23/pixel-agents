import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Pixel Agents Telemetry Extension for pi-coding-agent
 * 
 * Emits structured events to ~/.pi/agent/pixel-agents/<session-id>.jsonl
 * for consumption by the Pixel Agents VS Code extension.
 */

const TELEMETRY_DIR = path.join(os.homedir(), ".pi", "agent", "pixel-agents");

interface TelemetryEvent {
	type: string;
	sessionId: string;
	timestamp: number;
	// Tool execution fields
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	parentToolId?: string;
	// Tool result fields
	status?: 'ok' | 'error';
	error?: string;
	// Agent fields
	reason?: string;
}

class TelemetryWriter {
	private sessionId: string | null = null;
	private filePath: string | null = null;
	private writeQueue: TelemetryEvent[] = [];
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private parentToolStack: string[] = [];

	start(sessionId: string): void {
		this.sessionId = sessionId;
		
		// Ensure telemetry directory exists
		if (!fs.existsSync(TELEMETRY_DIR)) {
			fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
		}
		
		this.filePath = path.join(TELEMETRY_DIR, `${sessionId}.jsonl`);
		
		// Start flush timer (flush every 100ms for batching)
		this.flushTimer = setInterval(() => this.flush(), 100);
		
		console.log(`[PixelAgentsTelemetry] Started for session: ${sessionId}`);
	}

	stop(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		this.flush(); // Final flush
		console.log(`[PixelAgentsTelemetry] Stopped for session: ${this.sessionId}`);
	}

	enqueue(event: TelemetryEvent): void {
		if (!this.sessionId) return;
		this.writeQueue.push(event);
	}

	private flush(): void {
		if (!this.filePath || this.writeQueue.length === 0) return;
		
		const lines = this.writeQueue.map(e => JSON.stringify(e)).join('\n') + '\n';
		this.writeQueue = [];
		
		try {
			fs.appendFileSync(this.filePath, lines, 'utf-8');
		} catch (err) {
			console.error(`[PixelAgentsTelemetry] Write error: ${err}`);
		}
	}

	getCurrentParentToolId(): string | undefined {
		return this.parentToolStack.length > 0 
			? this.parentToolStack[this.parentToolStack.length - 1] 
			: undefined;
	}

	pushParentTool(toolCallId: string): void {
		this.parentToolStack.push(toolCallId);
	}

	popParentTool(): void {
		this.parentToolStack.pop();
	}
}

export default function (pi: ExtensionAPI) {
	const writer = new TelemetryWriter();

	// Get session ID from session manager
	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		// Use session filename as session ID (without path and extension)
		const sessionId = sessionFile 
			? path.basename(sessionFile, '.jsonl')
			: `ephemeral-${Date.now()}`;
		
		writer.start(sessionId);
		
		writer.enqueue({
			type: 'agent_start',
			sessionId,
			timestamp: Date.now(),
		});
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		writer.stop();
	});

	// Agent lifecycle
	pi.on("agent_start", async (_event, _ctx) => {
		// Agent started - could emit additional metadata here
	});

	pi.on("agent_end", async (event, _ctx) => {
		writer.enqueue({
			type: 'agent_end',
			sessionId: writer['sessionId'] ?? 'unknown',
			timestamp: Date.now(),
			reason: 'turn_complete',
		});
	});

	// Turn lifecycle (mapped to agent_start/agent_end for compatibility)
	pi.on("turn_start", async (_event, _ctx) => {
		// Turn started
	});

	pi.on("turn_end", async (_event, _ctx) => {
		writer.enqueue({
			type: 'agent_end',
			sessionId: writer['sessionId'] ?? 'unknown',
			timestamp: Date.now(),
			reason: 'turn_complete',
		});
	});

	// Message streaming (for text-only responses without tools)
	pi.on("message_start", async (event, _ctx) => {
		if (event.message.role === 'assistant') {
			writer.enqueue({
				type: 'message_streaming_start',
				sessionId: writer['sessionId'] ?? 'unknown',
				timestamp: Date.now(),
			});
		}
	});

	pi.on("message_update", async (event, _ctx) => {
		if (event.message.role === 'assistant') {
			writer.enqueue({
				type: 'message_streaming_update',
				sessionId: writer['sessionId'] ?? 'unknown',
				timestamp: Date.now(),
			});
		}
	});

	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role === 'assistant') {
			writer.enqueue({
				type: 'message_streaming_end',
				sessionId: writer['sessionId'] ?? 'unknown',
				timestamp: Date.now(),
			});
		}
	});

	// Tool execution lifecycle
	pi.on("tool_execution_start", async (event, _ctx) => {
		const parentToolId = writer.getCurrentParentToolId();
		
		writer.enqueue({
			type: 'tool_execution_start',
			sessionId: writer['sessionId'] ?? 'unknown',
			timestamp: Date.now(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			parentToolId,
		});
		
		// Track this as a parent for nested tools (e.g., subagents)
		writer.pushParentTool(event.toolCallId);
	});

	pi.on("tool_execution_end", async (event, _ctx) => {
		const parentToolId = writer.getCurrentParentToolId();
		
		writer.enqueue({
			type: 'tool_execution_end',
			sessionId: writer['sessionId'] ?? 'unknown',
			timestamp: Date.now(),
			toolCallId: event.toolCallId,
			status: event.isError ? 'error' : 'ok',
			error: event.isError ? String(event.result) : undefined,
			parentToolId,
		});
		
		// Pop from parent stack
		writer.popParentTool();
	});

	// Permission wait handling (for high-risk tools)
	pi.on("tool_call", async (event, ctx) => {
		const highRiskTools = ['bash', 'write', 'edit'];
		
		// Defensive: ensure toolName is a string
		const toolName = typeof event.toolName === 'string' ? event.toolName : String(event.toolName);
		
		if (highRiskTools.includes(toolName)) {
			// Emit permission wait start before the tool executes
			writer.enqueue({
				type: 'permission_wait_start',
				sessionId: writer['sessionId'] ?? 'unknown',
				timestamp: Date.now(),
				toolCallId: event.toolCallId,
				toolName: toolName,
			});
			
			// Ask user for confirmation before allowing high-risk tool
			// Extract meaningful args fields for display
			let argsStr = '';
			if (event.args && typeof event.args === 'object') {
				const args = event.args as Record<string, unknown>;
				if (toolName === 'bash' && typeof args.command === 'string') {
					argsStr = args.command.slice(0, 80);
				} else if ((toolName === 'write' || toolName === 'edit') && typeof args.path === 'string') {
					argsStr = args.path.slice(0, 80);
				} else {
					// Fallback: stringify with truncation
					try {
						argsStr = JSON.stringify(event.args);
						if (argsStr.length > 60) argsStr = argsStr.slice(0, 60) + '...';
					} catch {
						argsStr = '[args]';
					}
				}
			}
			const toolDesc = `${toolName}${argsStr ? ` ${argsStr}` : ''}`;
			const approved = await ctx.ui.confirm(
				`Allow ${toolDesc}?`,
				{ threatLevel: 'high' }
			);
			
			// Emit permission wait end after confirmation
			writer.enqueue({
				type: 'permission_wait_end',
				sessionId: writer['sessionId'] ?? 'unknown',
				timestamp: Date.now(),
				toolCallId: event.toolCallId,
				toolName: toolName,
				approved,
			});
			
			// If not approved, block the tool execution
			if (!approved) {
				// Emit tool_execution_end with error to indicate cancellation
				writer.enqueue({
					type: 'tool_execution_end',
					sessionId: writer['sessionId'] ?? 'unknown',
					timestamp: Date.now(),
					toolCallId: event.toolCallId,
					status: 'error',
					error: 'User denied permission',
				});
				
				// Return false to indicate tool should not execute
				return false;
			}
		}
		
		// Allow tool execution (either not high-risk or approved)
		return true;
	});

	console.log('[PixelAgentsTelemetry] Extension loaded');
}
