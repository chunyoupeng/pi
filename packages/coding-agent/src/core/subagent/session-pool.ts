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
