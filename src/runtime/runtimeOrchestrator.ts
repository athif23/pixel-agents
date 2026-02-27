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

	constructor(private readonly mode: RuntimeMode) {
		if (mode === RUNTIME_MODE.CLAUDE_ONLY || mode === RUNTIME_MODE.DUAL_READ_CLAUDE_AUTHORITATIVE) {
			this.state = RUNTIME_STATE.ACTIVE_CLAUDE;
		} else {
			this.state = RUNTIME_STATE.ACTIVE_PI;
		}
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
	}

	getRecentEvents(limit = 20): RuntimeEvent[] {
		if (limit <= 0) return [];
		return this.recentEvents.slice(-limit);
	}
}
