import {
	RUNTIME_EVENT_TYPE,
	RUNTIME_KIND,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEvent,
	type RuntimeOrchestrator,
	type RuntimeRecordProcessor,
} from './types.js';

function toTimestamp(record: Record<string, unknown>): number {
	const ts = record.timestamp;
	if (typeof ts === 'number') return ts;
	if (typeof ts === 'string') {
		const parsed = Date.parse(ts);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return Date.now();
}

/**
 * Pi telemetry event types (from pi extension)
 */
const PI_EVENT_TYPE = {
	AGENT_START: 'agent_start',
	AGENT_END: 'agent_end',
	TOOL_EXECUTION_START: 'tool_execution_start',
	TOOL_EXECUTION_UPDATE: 'tool_execution_update',
	TOOL_EXECUTION_END: 'tool_execution_end',
	TURN_START: 'turn_start',
	TURN_END: 'turn_end',
	MESSAGE_STREAMING_START: 'message_streaming_start',
	MESSAGE_STREAMING_UPDATE: 'message_streaming_update',
	MESSAGE_STREAMING_END: 'message_streaming_end',
} as const;

/**
 * Maps pi tool names to normalized tool names
 * Pi uses lowercase, normalize to match existing patterns
 */
function normalizeToolName(piToolName: string): string {
	const mapping: Record<string, string> = {
		read: 'Read',
		write: 'Write',
		edit: 'Edit',
		bash: 'Bash',
		grep: 'Grep',
		find: 'Find',
		ls: 'Ls',
	};
	return mapping[piToolName.toLowerCase()] ?? piToolName;
}

export class PiAdapter implements RuntimeRecordProcessor {
	constructor(private readonly orchestrator: RuntimeOrchestrator) {}

	processRecord(agentId: number, record: unknown): void {
		if (!record || typeof record !== 'object') return;
		const r = record as Record<string, unknown>;
		const eventType = r.type;
		if (typeof eventType !== 'string') return;

		switch (eventType) {
			case PI_EVENT_TYPE.AGENT_START:
				this.handleAgentStart(agentId, r);
				break;
			case PI_EVENT_TYPE.AGENT_END:
				this.handleAgentEnd(agentId, r);
				break;
			case PI_EVENT_TYPE.TOOL_EXECUTION_START:
				this.handleToolStart(agentId, r);
				break;
			case PI_EVENT_TYPE.TOOL_EXECUTION_END:
				this.handleToolEnd(agentId, r);
				break;
			case PI_EVENT_TYPE.TURN_START:
				this.handleTurnStart(agentId, r);
				break;
			case PI_EVENT_TYPE.TURN_END:
				this.handleTurnEnd(agentId, r);
				break;
			case PI_EVENT_TYPE.MESSAGE_STREAMING_START:
				this.handleStreamingStart(agentId, r);
				break;
			case PI_EVENT_TYPE.MESSAGE_STREAMING_UPDATE:
				// Ignore updates - just keep the typing state active
				break;
			case PI_EVENT_TYPE.MESSAGE_STREAMING_END:
				this.handleStreamingEnd(agentId, r);
				break;
			// Ignore tool updates for now (Slice 2 will add streaming/permission handling)
			case PI_EVENT_TYPE.TOOL_EXECUTION_UPDATE:
			default:
				break;
		}
	}

	private handleAgentStart(agentId: number, record: Record<string, unknown>): void {
		const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
		this.emit({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runtime: RUNTIME_KIND.PI,
			agentId,
			ts: toTimestamp(record),
			eventType: RUNTIME_EVENT_TYPE.AGENT_START,
			sessionId,
		});
	}

	private handleAgentEnd(agentId: number, record: Record<string, unknown>): void {
		const reason = typeof record.reason === 'string' ? record.reason : undefined;
		this.emit({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runtime: RUNTIME_KIND.PI,
			agentId,
			ts: toTimestamp(record),
			eventType: RUNTIME_EVENT_TYPE.AGENT_END,
			reason,
		});
	}

	private handleToolStart(agentId: number, record: Record<string, unknown>): void {
		const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : undefined;
		const toolNameRaw = typeof record.toolName === 'string' ? record.toolName : 'unknown';
		if (!toolCallId) return;

		const toolName = normalizeToolName(toolNameRaw);
		const argsPreview = record.args ? JSON.stringify(record.args).slice(0, 120) : undefined;
		const parentToolId = typeof record.parentToolId === 'string' ? record.parentToolId : undefined;

		this.emit({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runtime: RUNTIME_KIND.PI,
			agentId,
			ts: toTimestamp(record),
			eventType: RUNTIME_EVENT_TYPE.TOOL_START,
			toolCallId,
			toolName,
			argsPreview,
			parentToolId,
		});
	}

	private handleToolEnd(agentId: number, record: Record<string, unknown>): void {
		const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : undefined;
		if (!toolCallId) return;

		const status = record.error ? 'error' : 'ok';
		const error = typeof record.error === 'string' ? record.error : undefined;
		const parentToolId = typeof record.parentToolId === 'string' ? record.parentToolId : undefined;

		this.emit({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runtime: RUNTIME_KIND.PI,
			agentId,
			ts: toTimestamp(record),
			eventType: RUNTIME_EVENT_TYPE.TOOL_END,
			toolCallId,
			status,
			error,
			parentToolId,
		});
	}

	private handleTurnStart(agentId: number, record: Record<string, unknown>): void {
		// Turn start is implicit - we can use this for additional tracking if needed
		// For now, agent_start covers the main lifecycle
		void agentId;
		void record;
	}

	private handleTurnEnd(agentId: number, record: Record<string, unknown>): void {
		// Map turn_end to agent_end for consistency with Claude behavior
		this.emit({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runtime: RUNTIME_KIND.PI,
			agentId,
			ts: toTimestamp(record),
			eventType: RUNTIME_EVENT_TYPE.AGENT_END,
			reason: 'turn_complete',
		});
	}

	private handleStreamingStart(agentId: number, record: Record<string, unknown>): void {
		// Emit as a tool_start with a synthetic "typing" tool
		// This makes the character show typing animation during text streaming
		this.emit({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runtime: RUNTIME_KIND.PI,
			agentId,
			ts: toTimestamp(record),
			eventType: RUNTIME_EVENT_TYPE.TOOL_START,
			toolCallId: `streaming-${Date.now()}`,
			toolName: 'Typing',
			argsPreview: 'Generating response...',
		});
	}

	private handleStreamingEnd(agentId: number, record: Record<string, unknown>): void {
		// Emit tool_end for the streaming
		this.emit({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runtime: RUNTIME_KIND.PI,
			agentId,
			ts: toTimestamp(record),
			eventType: RUNTIME_EVENT_TYPE.TOOL_END,
			toolCallId: `streaming-${Date.now()}`,
			status: 'ok',
		});
	}

	private emit(event: RuntimeEvent): void {
		this.orchestrator.handleEvent(event);
	}
}
