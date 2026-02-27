import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	FILE_WATCHER_POLL_INTERVAL_MS,
	JSONL_POLL_INTERVAL_MS,
} from './constants.js';
import type { RuntimeOrchestrator, RuntimeRecordProcessor } from './runtime/types.js';

const PI_TELEMETRY_DIR = path.join(os.homedir(), '.pi', 'agent', 'pixel-agents');

interface PiSessionWatcher {
	sessionId: string;
	filePath: string;
	fileOffset: number;
	lineBuffer: string;
	fileWatcher?: fs.FSWatcher;
	pollTimer?: ReturnType<typeof setInterval>;
}

export class PiTelemetryWatcher {
	private readonly sessions = new Map<string, PiSessionWatcher>();
	private readonly knownFiles = new Set<string>();
	private dirWatcher?: fs.FSWatcher;
	private dirPollTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly orchestrator: RuntimeOrchestrator,
		private readonly adapter: RuntimeRecordProcessor,
	) {}

	start(): void {
		this.ensureTelemetryDir();
		this.startDirectoryWatching();
		this.scanExistingFiles();
	}

	stop(): void {
		this.dirWatcher?.close();
		if (this.dirPollTimer) clearInterval(this.dirPollTimer);
		for (const session of this.sessions.values()) {
			session.fileWatcher?.close();
			if (session.pollTimer) clearInterval(session.pollTimer);
		}
		this.sessions.clear();
	}

	private ensureTelemetryDir(): void {
		try {
			if (!fs.existsSync(PI_TELEMETRY_DIR)) {
				fs.mkdirSync(PI_TELEMETRY_DIR, { recursive: true });
			}
		} catch (e) {
			console.log(`[Pixel Agents] Failed to create pi telemetry dir: ${e}`);
		}
	}

	private startDirectoryWatching(): void {
		// Primary: fs.watch on directory
		try {
			this.dirWatcher = fs.watch(PI_TELEMETRY_DIR, (eventType, filename) => {
				if (filename?.endsWith('.jsonl')) {
					this.handleFileChange(filename);
				}
			});
		} catch (e) {
			console.log(`[Pixel Agents] fs.watch on pi telemetry dir failed: ${e}`);
		}

		// Backup: poll directory every 2s
		this.dirPollTimer = setInterval(() => {
			this.scanForNewFiles();
		}, FILE_WATCHER_POLL_INTERVAL_MS);
	}

	private scanExistingFiles(): void {
		try {
			const files = fs.readdirSync(PI_TELEMETRY_DIR)
				.filter(f => f.endsWith('.jsonl'));
			for (const file of files) {
				this.knownFiles.add(file);
				this.startSessionWatcher(file);
			}
		} catch { /* dir may not exist yet */ }
	}

	private scanForNewFiles(): void {
		try {
			const files = fs.readdirSync(PI_TELEMETRY_DIR)
				.filter(f => f.endsWith('.jsonl'));
			for (const file of files) {
				if (!this.knownFiles.has(file)) {
					this.knownFiles.add(file);
					this.startSessionWatcher(file);
				}
			}
		} catch { /* dir may not exist */ }
	}

	private handleFileChange(filename: string): void {
		if (!this.knownFiles.has(filename)) {
			this.knownFiles.add(filename);
			this.startSessionWatcher(filename);
		}
	}

	private startSessionWatcher(filename: string): void {
		const sessionId = path.basename(filename, '.jsonl');
		const filePath = path.join(PI_TELEMETRY_DIR, filename);

		console.log(`[Pixel Agents] Starting pi telemetry watcher for session: ${sessionId}`);

		const session: PiSessionWatcher = {
			sessionId,
			filePath,
			fileOffset: 0,
			lineBuffer: '',
		};
		this.sessions.set(sessionId, session);

		// Start file watching (similar to fileWatcher.ts pattern)
		try {
			session.fileWatcher = fs.watch(filePath, () => {
				this.readNewLines(session);
			});
		} catch (e) {
			console.log(`[Pixel Agents] fs.watch failed for pi session ${sessionId}: ${e}`);
		}

		// Backup polling
		session.pollTimer = setInterval(() => {
			if (!this.sessions.has(sessionId)) {
				if (session.pollTimer) clearInterval(session.pollTimer);
				return;
			}
			this.readNewLines(session);
		}, FILE_WATCHER_POLL_INTERVAL_MS);

		// Also poll specifically for file creation (file may not exist yet)
		const creationPoll = setInterval(() => {
			if (fs.existsSync(filePath)) {
				clearInterval(creationPoll);
				this.readNewLines(session);
			}
		}, JSONL_POLL_INTERVAL_MS);
		// Stop polling after 30s if file never appears
		setTimeout(() => clearInterval(creationPoll), 30000);
	}

	private readNewLines(session: PiSessionWatcher): void {
		try {
			const stat = fs.statSync(session.filePath);
			if (stat.size <= session.fileOffset) return;

			const buf = Buffer.alloc(stat.size - session.fileOffset);
			const fd = fs.openSync(session.filePath, 'r');
			fs.readSync(fd, buf, 0, buf.length, session.fileOffset);
			fs.closeSync(fd);
			session.fileOffset = stat.size;

			const text = session.lineBuffer + buf.toString('utf-8');
			const lines = text.split('\n');
			session.lineBuffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;
				this.processLine(session.sessionId, line);
			}
		} catch (e) {
			// File may not exist yet or be unreadable
			console.log(`[Pixel Agents] Read error for pi session ${session.sessionId}: ${e}`);
		}
	}

	private processLine(sessionId: string, line: string): void {
		try {
			const record = JSON.parse(line);
			// Session ID is derived from filename, use a hash or map to agent ID
			// For now, emit with sessionId as identifier - agent manager will map
			const agentId = this.resolveAgentId(sessionId);
			if (agentId !== null) {
				this.adapter.processRecord(agentId, record);
			}
		} catch (e) {
			console.log(`[Pixel Agents] Failed to parse pi telemetry line: ${e}`);
		}
	}

	private readonly sessionToAgent = new Map<string, number>();

	/**
	 * Resolve session ID to agent ID.
	 */
	private resolveAgentId(sessionId: string): number | null {
		return this.sessionToAgent.get(sessionId) ?? null;
	}

	/**
	 * Register a mapping between pi session ID and agent ID.
	 * Called by agentManager when launching a pi terminal.
	 */
	registerSession(sessionId: string, agentId: number): void {
		this.sessionToAgent.set(sessionId, agentId);
		console.log(`[Pixel Agents] Registered pi session ${sessionId} -> agent ${agentId}`);
	}

	/**
	 * Unregister a session when agent closes.
	 */
	unregisterSession(sessionId: string): void {
		this.sessionToAgent.delete(sessionId);
		const session = this.sessions.get(sessionId);
		if (session) {
			session.fileWatcher?.close();
			if (session.pollTimer) clearInterval(session.pollTimer);
			this.sessions.delete(sessionId);
		}
	}
}
