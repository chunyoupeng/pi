import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";

export interface EntryUsageState {
	hitCount: number;
	lastHitSessionSeq: number;
	createdSessionSeq: number;
}

export interface MemoryStateData {
	version: 1;
	sessionSeq: number;
	seenSessionIds: string[];
	lastDecaySessionSeq: number;
	entries: Record<string, EntryUsageState>;
}

export const ARCHIVE_SCORE_THRESHOLD = 0.125;
export const MIN_SESSIONS_BEFORE_ARCHIVE = 15;

const SEEN_SESSION_RING_CAP = 500;

export function computeDecayScore(usage: EntryUsageState | undefined, currentSessionSeq: number): number {
	const halfLife = 5 * 2 ** Math.min(Math.max(0, usage?.hitCount ?? 0), 6);
	const anchorSeq = usage ? Math.max(usage.lastHitSessionSeq, usage.createdSessionSeq) : currentSessionSeq;
	const delta = Math.max(0, currentSessionSeq - anchorSeq);
	return 2 ** (-delta / halfLife);
}

function createEmptyState(): MemoryStateData {
	return {
		version: 1,
		sessionSeq: 0,
		seenSessionIds: [],
		lastDecaySessionSeq: 0,
		entries: {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function parseStateData(raw: unknown): MemoryStateData {
	if (!isRecord(raw)) return createEmptyState();

	const sessionSeq = toNonNegativeInt(raw.sessionSeq, 0);
	const lastDecaySessionSeq = toNonNegativeInt(raw.lastDecaySessionSeq, 0);

	const seenSessionIds: string[] = Array.isArray(raw.seenSessionIds)
		? raw.seenSessionIds
				.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
				.slice(-SEEN_SESSION_RING_CAP)
		: [];

	const entries: Record<string, EntryUsageState> = {};
	if (isRecord(raw.entries)) {
		for (const [id, usage] of Object.entries(raw.entries)) {
			if (!isRecord(usage)) continue;
			entries[id] = {
				hitCount: toNonNegativeInt(usage.hitCount, 0),
				lastHitSessionSeq: toNonNegativeInt(usage.lastHitSessionSeq, 0),
				createdSessionSeq: toNonNegativeInt(usage.createdSessionSeq, 0),
			};
		}
	}

	return {
		version: 1,
		sessionSeq,
		seenSessionIds,
		lastDecaySessionSeq,
		entries,
	};
}

export class MemoryStateLedger {
	readonly statePath: string;

	constructor(memoryDir: string) {
		this.statePath = path.join(memoryDir, "state.json");
	}

	async read(): Promise<MemoryStateData> {
		return this.readUnlocked();
	}

	async mutate<T>(fn: (state: MemoryStateData) => T | Promise<T>): Promise<T> {
		return withFileMutationQueue(this.statePath, async () => {
			const state = await this.readUnlocked();
			const result = await fn(state);
			await this.writeUnlocked(state);
			return result;
		});
	}

	async recordSession(sessionId: string): Promise<MemoryStateData> {
		const trimmed = sessionId.trim();
		if (!trimmed) {
			return this.read();
		}
		return withFileMutationQueue(this.statePath, async () => {
			const state = await this.readUnlocked();
			if (this.applySessionId(state, trimmed)) {
				await this.writeUnlocked(state);
			}
			return state;
		});
	}

	async recordEntryCreate(id: string): Promise<void> {
		await this.mutate((state) => {
			state.entries[id] = {
				hitCount: 0,
				lastHitSessionSeq: state.sessionSeq,
				createdSessionSeq: state.sessionSeq,
			};
		});
	}

	async recordHits(ids: readonly string[], sessionId?: string): Promise<void> {
		const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
		const trimmedSession = sessionId?.trim();
		if (uniqueIds.length === 0 && !trimmedSession) {
			return;
		}
		await this.mutate((state) => {
			if (trimmedSession) {
				this.applySessionId(state, trimmedSession);
			}
			for (const id of uniqueIds) {
				const existing = state.entries[id];
				if (existing) {
					existing.hitCount += 1;
					existing.lastHitSessionSeq = state.sessionSeq;
				} else {
					state.entries[id] = {
						hitCount: 1,
						lastHitSessionSeq: state.sessionSeq,
						createdSessionSeq: state.sessionSeq,
					};
				}
			}
		});
	}

	async removeEntry(id: string): Promise<void> {
		await withFileMutationQueue(this.statePath, async () => {
			if (!fs.existsSync(this.statePath)) return;
			const state = await this.readUnlocked();
			if (!(id in state.entries)) return;
			delete state.entries[id];
			await this.writeUnlocked(state);
		});
	}

	private applySessionId(state: MemoryStateData, sessionId: string): boolean {
		if (!sessionId || state.seenSessionIds.includes(sessionId)) {
			return false;
		}
		state.sessionSeq += 1;
		state.seenSessionIds.push(sessionId);
		if (state.seenSessionIds.length > SEEN_SESSION_RING_CAP) {
			state.seenSessionIds = state.seenSessionIds.slice(-SEEN_SESSION_RING_CAP);
		}
		return true;
	}

	private async readUnlocked(): Promise<MemoryStateData> {
		try {
			const content = await fs.promises.readFile(this.statePath, "utf8");
			const parsed: unknown = JSON.parse(content);
			return parseStateData(parsed);
		} catch {
			return createEmptyState();
		}
	}

	private async writeUnlocked(state: MemoryStateData): Promise<void> {
		await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
		const tmp = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		try {
			await fs.promises.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			await fs.promises.rename(tmp, this.statePath);
		} catch (error) {
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw error;
		}
	}
}
