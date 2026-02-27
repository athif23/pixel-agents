import * as vscode from 'vscode';
import type { RuntimeEvent, RuntimeOrchestrator } from './types.js';

export const RUNTIME_MODE = {
	CLAUDE_ONLY: 'claude-only',
	DUAL_READ_CLAUDE_AUTHORITATIVE: 'dual-read-claude-authoritative',
	PI_AUTHORITATIVE: 'pi-authoritative',
	PI_DEFAULT: 'pi-default',
} as const;

export type RuntimeMode = typeof RUNTIME_MODE[keyof typeof RUNTIME_MODE];

export const RUNTIME_STATE = {
	IDLE: 'Idle',
	ACTIVE_CLAUDE: 'ActiveClaude',
	ACTIVE_PI: 'ActivePi',
	SWAPPING: 'Swapping',
	FAILED_ROLLBACK: 'FailedRollback',
} as const;

export type RuntimeState = typeof RUNTIME_STATE[keyof typeof RUNTIME_STATE];

export class RuntimeOrchestratorImpl implements RuntimeOrchestrator {
	private state: RuntimeState = RUNTIME_STATE.IDLE;
	private swapLocked = false;
	private readonly recentEvents: RuntimeEvent[] = [];
	private readonly activeTools = new Map<string, { toolName: string; agentId: number }>();
	private webview?: vscode.Webview;

	constructor(private readonly mode: RuntimeMode) {
		if (mode === RUNTIME_MODE.CLAUDE_ONLY || mode === RUNTIME_MODE.DUAL_READ_CLAUDE_AUTHORITATIVE) {
			this.state = RUNTIME_STATE.ACTIVE_CLAUDE;
		} else {
			this.state = RUNTIME_STATE.ACTIVE_PI;
		}
	}

	setWebview(webview: vscode.Webview | undefined): void {
		this.webview = webview;
	}

	getState(): RuntimeState {
		return this.state;
	}

	getMode(): RuntimeMode {
		return this.mode;
	}

	isSwapLocked(): boolean {
		return this.swapLocked;
	}

	acquireSwapLock(): boolean {
		if (this.swapLocked) return false;
		this.swapLocked = true;
		this.state = RUNTIME_STATE.SWAPPING;
		return true;
	}

	releaseSwapLock(nextState?: RuntimeState): void {
		this.swapLocked = false;
		if (nextState) {
			this.state = nextState;
			return;
		}
		if (this.mode === RUNTIME_MODE.CLAUDE_ONLY || this.mode === RUNTIME_MODE.DUAL_READ_CLAUDE_AUTHORITATIVE) {
			this.state = RUNTIME_STATE.ACTIVE_CLAUDE;
		} else {
			this.state = RUNTIME_STATE.ACTIVE_PI;
		}
	}

	markFailedRollback(): void {
		this.swapLocked = false;
		this.state = RUNTIME_STATE.FAILED_ROLLBACK;
	}

	handleEvent(event: RuntimeEvent): void {
		this.recentEvents.push(event);
		if (this.recentEvents.length > 200) {
			this.recentEvents.shift();
		}

		// Forward to webview for UI updates
		this.emitToWebview(event);
	}

	private emitToWebview(event: RuntimeEvent): void {
		if (!this.webview) return;

		switch (event.eventType) {
			case 'typing_start':
				this.webview.postMessage({
					type: 'agentStatus',
					id: event.agentId,
					status: 'Working...',
				});
				break;
			case 'typing_end':
				this.webview.postMessage({
					type: 'agentStatus',
					id: event.agentId,
					status: 'active',
				});
				break;
			case 'typing_end':
				// Typing ended, status will be cleared by tool_start or agent_end
				break;
			case 'tool_start':
				this.activeTools.set(event.toolCallId, { toolName: event.toolName, agentId: event.agentId });
				this.webview.postMessage({
					type: 'agentToolStart',
					id: event.agentId,
					toolId: event.toolCallId,
					status: `Running ${event.toolName}${event.argsPreview ? ` ${event.argsPreview.slice(0, 40)}` : ''}`,
				});
				break;

			case 'tool_end':
				this.activeTools.delete(event.toolCallId);
				this.webview.postMessage({
					type: 'agentToolDone',
					id: event.agentId,
					toolId: event.toolCallId,
				});
				break;

			case 'agent_end':
				// Clear all active tools for this agent
				for (const [toolId, info] of this.activeTools) {
					if (info.agentId === event.agentId) {
						this.activeTools.delete(toolId);
						this.webview.postMessage({
							type: 'agentToolDone',
							id: event.agentId,
							toolId,
						});
					}
				}
				// Emit waiting status
				this.webview.postMessage({
					type: 'agentStatus',
					id: event.agentId,
					status: 'waiting',
				});
				break;

			case 'permission_wait_start':
				this.webview.postMessage({
					type: 'agentToolPermission',
					id: event.agentId,
					toolId: event.toolCallId,
					status: event.toolName,
				});
				break;

			case 'permission_wait_end':
				this.webview.postMessage({
					type: 'agentToolPermissionClear',
					id: event.agentId,
				});
				break;

			case 'subagent_start':
				this.webview.postMessage({
					type: 'subagentToolStart',
					id: event.agentId,
					parentToolId: event.parentToolId,
					status: event.label ?? 'Subtask',
				});
				break;

			case 'subagent_end':
				this.webview.postMessage({
					type: 'subagentToolDone',
					id: event.agentId,
					parentToolId: event.parentToolId,
				});
				break;
		}
	}

	getRecentEvents(limit = 20): RuntimeEvent[] {
		if (limit <= 0) return [];
		return this.recentEvents.slice(-limit);
	}
}
