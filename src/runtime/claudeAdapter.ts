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

export class ClaudeAdapter implements RuntimeRecordProcessor {
	constructor(private readonly orchestrator: RuntimeOrchestrator) {}

	processRecord(agentId: number, record: unknown): void {
		if (!record || typeof record !== 'object') return;
		const r = record as Record<string, unknown>;
		const type = r.type;
		if (typeof type !== 'string') return;

		if (type === 'assistant') {
			this.handleAssistant(agentId, r);
			return;
		}
		if (type === 'user') {
			this.handleUser(agentId, r);
			return;
		}
		if (type === 'system' && r.subtype === 'turn_duration') {
			this.emit({
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				runtime: RUNTIME_KIND.CLAUDE,
				agentId,
				ts: toTimestamp(r),
				eventType: RUNTIME_EVENT_TYPE.AGENT_END,
				reason: 'turn_complete',
			});
			return;
		}
		if (type === 'progress') {
			this.handleProgress(agentId, r);
		}
	}

	private handleAssistant(agentId: number, record: Record<string, unknown>): void {
		const message = record.message;
		if (!message || typeof message !== 'object') return;
		const content = (message as Record<string, unknown>).content;
		if (!Array.isArray(content)) return;

		for (const block of content) {
			if (!block || typeof block !== 'object') continue;
			const b = block as Record<string, unknown>;
			if (b.type !== 'tool_use') continue;
			if (typeof b.id !== 'string') continue;
			const toolName = typeof b.name === 'string' ? b.name : 'unknown';
			const argsPreview = b.input ? JSON.stringify(b.input).slice(0, 120) : undefined;
			this.emit({
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				runtime: RUNTIME_KIND.CLAUDE,
				agentId,
				ts: toTimestamp(record),
				eventType: RUNTIME_EVENT_TYPE.TOOL_START,
				toolCallId: b.id,
				toolName,
				argsPreview,
			});
		}
	}

	private handleUser(agentId: number, record: Record<string, unknown>): void {
		const message = record.message;
		if (!message || typeof message !== 'object') return;
		const content = (message as Record<string, unknown>).content;
		if (!Array.isArray(content)) return;

		for (const block of content) {
			if (!block || typeof block !== 'object') continue;
			const b = block as Record<string, unknown>;
			if (b.type !== 'tool_result') continue;
			if (typeof b.tool_use_id !== 'string') continue;
			this.emit({
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				runtime: RUNTIME_KIND.CLAUDE,
				agentId,
				ts: toTimestamp(record),
				eventType: RUNTIME_EVENT_TYPE.TOOL_END,
				toolCallId: b.tool_use_id,
				status: 'ok',
			});
		}
	}

	private handleProgress(agentId: number, record: Record<string, unknown>): void {
		const parentToolId = typeof record.parentToolUseID === 'string' ? record.parentToolUseID : undefined;
		if (!parentToolId) return;
		const data = record.data;
		if (!data || typeof data !== 'object') return;
		const msg = (data as Record<string, unknown>).message;
		if (!msg || typeof msg !== 'object') return;
		const msgType = (msg as Record<string, unknown>).type;
		const innerMessage = (msg as Record<string, unknown>).message;
		if (!innerMessage || typeof innerMessage !== 'object') return;
		const content = (innerMessage as Record<string, unknown>).content;
		if (!Array.isArray(content)) return;

		const subagentId = `${agentId}:${parentToolId}`;
		if (msgType === 'assistant') {
			for (const block of content) {
				if (!block || typeof block !== 'object') continue;
				const b = block as Record<string, unknown>;
				if (b.type !== 'tool_use' || typeof b.id !== 'string') continue;
				const toolName = typeof b.name === 'string' ? b.name : 'unknown';
				this.emit({
					schemaVersion: RUNTIME_SCHEMA_VERSION,
					runtime: RUNTIME_KIND.CLAUDE,
					agentId,
					ts: toTimestamp(record),
					eventType: RUNTIME_EVENT_TYPE.SUBAGENT_START,
					subagentId,
					parentToolId,
					label: toolName,
				});
				this.emit({
					schemaVersion: RUNTIME_SCHEMA_VERSION,
					runtime: RUNTIME_KIND.CLAUDE,
					agentId,
					ts: toTimestamp(record),
					eventType: RUNTIME_EVENT_TYPE.TOOL_START,
					toolCallId: b.id,
					toolName,
					parentToolId,
				});
			}
			return;
		}

		if (msgType === 'user') {
			for (const block of content) {
				if (!block || typeof block !== 'object') continue;
				const b = block as Record<string, unknown>;
				if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
				this.emit({
					schemaVersion: RUNTIME_SCHEMA_VERSION,
					runtime: RUNTIME_KIND.CLAUDE,
					agentId,
					ts: toTimestamp(record),
					eventType: RUNTIME_EVENT_TYPE.TOOL_END,
					toolCallId: b.tool_use_id,
					status: 'ok',
					parentToolId,
				});
				this.emit({
					schemaVersion: RUNTIME_SCHEMA_VERSION,
					runtime: RUNTIME_KIND.CLAUDE,
					agentId,
					ts: toTimestamp(record),
					eventType: RUNTIME_EVENT_TYPE.SUBAGENT_END,
					subagentId,
					parentToolId,
					reason: 'tool_result',
				});
			}
		}
	}

	private emit(event: RuntimeEvent): void {
		this.orchestrator.handleEvent(event);
	}
}
