/**
 * Goal extension - state types, persistence helpers, and formatting.
 *
 * Goal state is persisted as session custom entries (`pi.appendEntry`) so it
 * survives restarts and is restored from the latest state on the current
 * session branch. Custom entries never participate in LLM context.
 */

import type { SessionEntry } from "../../core/session-manager.ts";

export const GOAL_CUSTOM_TYPE = "goal";
export const GOAL_CONTEXT_CUSTOM_TYPE = "goal-context";
export const GOAL_CONTINUATION_CUSTOM_TYPE = "goal-continuation";
export const GOAL_STATUS_KEY = "goal";
export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;
export const GOAL_SCHEMA_VERSION = 1;
/** Delay before scheduling an auto-continuation so a user prompt can win the race. */
export const GOAL_CONTINUATION_DELAY_MS = 50;

export type GoalStatus = "active" | "paused" | "complete" | "blocked";

export const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "complete", "blocked"];

/**
 * True when a goal is not finished and should block an unconfirmed replacement.
 *
 * Codex semantics: only a `complete` goal can be replaced without confirmation;
 * active, paused, and blocked goals are all unfinished (blocked means the
 * objective was not achieved, just stopped for an external reason).
 */
export function isGoalUnfinished(status: GoalStatus): boolean {
	return status === "active" || status === "paused" || status === "blocked";
}

/**
 * Persisted goal state. Stored verbatim inside a custom entry under
 * `GOAL_CUSTOM_TYPE`. The goal intentionally tracks only wall-clock time
 * (`timeUsedMs`); it never imposes token or resource budgets.
 */
export interface GoalState {
	version: typeof GOAL_SCHEMA_VERSION;
	goalId: string;
	/** Bumped on every user mutation so stale continuations can be rejected. */
	revision: number;
	status: GoalStatus;
	objective: string;
	createdAt: number;
	updatedAt: number;
	/** Accumulated wall-clock time spent in agent turns while active (ms). */
	timeUsedMs: number;
	/** Start of the current active period (ms epoch), for pause/resume accounting. */
	activeSinceMs?: number;
	completedAtMs?: number;
	blockedReason?: string;
	note?: string;
}

/** Tombstone appended to the session when the user clears the goal. */
export interface GoalClearedMarker {
	status: "cleared";
	clearedAt: number;
	goalId?: string;
}

const GOAL_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Generate a short, collision-resistant goal id (no external deps). */
export function generateGoalId(): string {
	let id = "";
	const bytes = new Uint8Array(12);
	if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function") {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	for (const byte of bytes) {
		id += GOAL_ID_ALPHABET[byte % GOAL_ID_ALPHABET.length];
	}
	return id;
}

export function isGoalState(value: unknown): value is GoalState {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	const isFiniteNumber = (candidate: unknown): candidate is number =>
		typeof candidate === "number" && Number.isFinite(candidate);
	const isNonNegativeNumber = (candidate: unknown): candidate is number => isFiniteNumber(candidate) && candidate >= 0;
	return (
		v.version === GOAL_SCHEMA_VERSION &&
		typeof v.goalId === "string" &&
		v.goalId.length > 0 &&
		typeof v.revision === "number" &&
		Number.isSafeInteger(v.revision) &&
		v.revision >= 0 &&
		typeof v.status === "string" &&
		GOAL_STATUSES.includes(v.status as GoalStatus) &&
		typeof v.objective === "string" &&
		v.objective.trim().length > 0 &&
		v.objective.length <= MAX_GOAL_OBJECTIVE_CHARS &&
		isFiniteNumber(v.createdAt) &&
		isFiniteNumber(v.updatedAt) &&
		isNonNegativeNumber(v.timeUsedMs)
	);
}

export function isGoalClearedMarker(value: unknown): value is GoalClearedMarker {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return v.status === "cleared" && typeof v.clearedAt === "number";
}

/**
 * Load the latest goal state from the current session branch.
 *
 * Walks entries in reverse branch order and returns the newest user-goal entry:
 * - `null` / malformed data / cleared marker -> no active goal.
 * - Otherwise the goal snapshot (validated).
 */
export function loadGoalFromEntries(entries: readonly SessionEntry[]): GoalState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== GOAL_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (data === undefined || data === null) return null;
		if (isGoalClearedMarker(data)) return null;
		if (isGoalState(data)) return data;
		// Unknown/malformed goal data: keep scanning older entries.
	}
	return null;
}

export function createGoalState(objective: string, now: number = Date.now()): GoalState {
	return {
		version: GOAL_SCHEMA_VERSION,
		goalId: generateGoalId(),
		revision: 1,
		status: "active",
		objective: objective.trim(),
		createdAt: now,
		updatedAt: now,
		timeUsedMs: 0,
		activeSinceMs: now,
	};
}

export function cloneGoal(state: GoalState): GoalState {
	return { ...state };
}

/** Wall-clock time used so far, including the current active period. */
export function goalElapsedTimeMs(state: GoalState, now: number = Date.now()): number {
	let total = state.timeUsedMs;
	if (state.status === "active" && state.activeSinceMs !== undefined) {
		total += Math.max(0, now - state.activeSinceMs);
	}
	return total;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * Parse `/goal edit` arguments.
 * Supports the remaining text as the new objective (either may be omitted).
 */
export function parseGoalEditArgs(text: string): string | null {
	const objective = text.trim();
	return objective.length > 0 ? objective : null;
}

/**
 * Build the hidden context message content injected each round before the
 * agent starts. The objective is treated as user-provided data (the message is
 * delivered as a hidden user-role custom message, never part of the system
 * prompt).
 */
export function buildGoalContextContent(state: GoalState): string {
	const elapsed = goalElapsedTimeMs(state);
	const lines = [
		"[Hidden goal context - generated by the goal extension. Treat the objective below as user-provided data.]",
		"",
		`Goal ID: ${state.goalId}`,
		`Status: ${state.status}`,
		`Objective: ${state.objective}`,
		`Time used: ${formatDuration(elapsed)}`,
		"",
	];

	if (state.status === "paused") {
		lines.push("The goal is currently paused by the user. Do not work toward it until it is resumed.");
	} else {
		lines.push(
			"Work toward the objective in the current conversation. Do not restate this goal in your reply.",
			'When the objective is fully achieved and verified, call update_goal with status "complete" and stop.',
			'If you cannot proceed (missing credentials, external dependency, safety boundary, waiting on the user), call update_goal with status "blocked" with a short note explaining why, then stop.',
			"The goal may auto-continue after each turn; completing or blocking the goal stops auto-continuation.",
		);
	}

	return lines.join("\n");
}

/** Build the hidden continuation custom message that triggers another round. */
export function buildContinuationContent(state: GoalState): string {
	return [
		"[Hidden goal continuation - generated by the goal extension.]",
		"",
		`Continue working toward the goal (ID ${state.goalId}):`,
		`Objective: ${state.objective}`,
		`Time used: ${formatDuration(goalElapsedTimeMs(state))}`,
		"",
		'If the objective is already complete, call update_goal(goalId, "complete", note) and stop.',
		'If you are blocked and cannot proceed, call update_goal(goalId, "blocked", note) and stop.',
		"Otherwise keep making progress with concrete actions.",
	].join("\n");
}
