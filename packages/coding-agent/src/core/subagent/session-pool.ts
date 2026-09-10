import type { Agent } from "@earendil-works/pi-agent-core";
import type { SubagentExecutionStep, SubagentUsage } from "./types.ts";

export interface SubagentSession {
	sessionId: string;
	name: string;
	agent: string;
	subAgent: Agent;
	createdAt: number;
	lastUsedAt: number;
	totalTurns: number;
	totalUsage: SubagentUsage;
	historySteps: SubagentExecutionStep[];
}

export class SubagentSessionPool {
	private _sessions: Map<string, SubagentSession>;
	private busySessions = new Set<string>();

	constructor() {
		this._sessions = new Map<string, SubagentSession>();
	}

	get(sessionId: string): SubagentSession | undefined {
		return this._sessions.get(sessionId);
	}

	set(sessionId: string, session: SubagentSession): void {
		this._sessions.set(sessionId, session);
	}

	has(sessionId: string): boolean {
		return this._sessions.has(sessionId);
	}

	acquire(sessionId: string): () => void {
		this.assertIdle(sessionId);
		this.busySessions.add(sessionId);
		return () => {
			this.busySessions.delete(sessionId);
		};
	}

	private assertIdle(sessionId: string): void {
		if (this.busySessions.has(sessionId) || this._sessions.get(sessionId)?.subAgent.signal) {
			throw new Error(`Subagent session '${sessionId}' is busy; wait until it is idle before resuming or resetting`);
		}
	}

	delete(sessionId: string): boolean {
		return this._sessions.delete(sessionId);
	}

	clear(): void {
		this._sessions.clear();
	}

	list(): SubagentSession[] {
		return Array.from(this._sessions.values());
	}
}
