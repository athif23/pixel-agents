export const RUNTIME_SCHEMA_VERSION = 1;

export const RUNTIME_KIND = {
	CLAUDE: 'claude',
	PI: 'pi',
} as const;

export type RuntimeKind = typeof RUNTIME_KIND[keyof typeof RUNTIME_KIND];

export const RUNTIME_EVENT_TYPE = {
	AGENT_START: 'agent_start',
	AGENT_END: 'agent_end',
	TOOL_START: 'tool_start',
	TOOL_END: 'tool_end',
	TYPING_START: 'typing_start',
	TYPING_END: 'typing_end',
	PERMISSION_WAIT_START: 'permission_wait_start',
	PERMISSION_WAIT_END: 'permission_wait_end',
	SUBAGENT_START: 'subagent_start',
	SUBAGENT_END: 'subagent_end',
} as const;

export type RuntimeEventType = typeof RUNTIME_EVENT_TYPE[keyof typeof RUNTIME_EVENT_TYPE];

interface RuntimeEventBase {
	schemaVersion: number;
	runtime: RuntimeKind;
	agentId: number;
	ts: number;
	eventType: RuntimeEventType;
}

export interface AgentStartEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.AGENT_START;
	sessionId?: string;
}

export interface AgentEndEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.AGENT_END;
	reason?: string;
}

export interface ToolStartEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.TOOL_START;
	toolCallId: string;
	toolName: string;
	argsPreview?: string;
	parentToolId?: string;
}

export interface ToolEndEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.TOOL_END;
	toolCallId: string;
	status?: 'ok' | 'error';
	error?: string;
	parentToolId?: string;
}

export interface TypingStartEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.TYPING_START;
}

export interface TypingEndEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.TYPING_END;
}

export interface PermissionWaitStartEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.PERMISSION_WAIT_START;
	toolCallId: string;
	toolName: string;
	isSubagent?: boolean;
	parentToolId?: string;
}

export interface PermissionWaitEndEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.PERMISSION_WAIT_END;
	toolCallId: string;
	isSubagent?: boolean;
	parentToolId?: string;
}

export interface SubagentStartEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.SUBAGENT_START;
	subagentId: string;
	parentToolId: string;
	label?: string;
}

export interface SubagentEndEvent extends RuntimeEventBase {
	eventType: typeof RUNTIME_EVENT_TYPE.SUBAGENT_END;
	subagentId: string;
	parentToolId: string;
	reason?: string;
}

export type RuntimeEvent =
	| AgentStartEvent
	| AgentEndEvent
	| ToolStartEvent
	| ToolEndEvent
	| TypingStartEvent
	| TypingEndEvent
	| PermissionWaitStartEvent
	| PermissionWaitEndEvent
	| SubagentStartEvent
	| SubagentEndEvent;

export interface RuntimeRecordProcessor {
	processRecord(agentId: number, record: unknown): void;
}

export interface RuntimeOrchestrator {
	handleEvent(event: RuntimeEvent): void;
}
