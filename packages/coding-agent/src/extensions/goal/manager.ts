/**
 * Goal extension - goal lifecycle controller.
 *
 * Manages goal mutations (create/replace, pause, resume, clear, edit, complete,
 * block), active run time accounting, consecutive idle-round protection, and
 * `agent_before_settle` continuation decisions. Kept decoupled from ExtensionAPI
 * so every transition can be unit tested directly.
 */

import type { SessionEntry } from "../../core/session-manager.ts";
import {
	buildContinuationContent,
	buildGoalContextContent,
	cloneGoal,
	createGoalState,
	type GoalClearedMarker,
	type GoalContinuationDetails,
	type GoalState,
	isGoalUnfinished,
	loadGoalFromEntries,
	MAX_CONSECUTIVE_IDLE_ROUNDS,
	MAX_GOAL_OBJECTIVE_CHARS,
} from "./state.ts";

export type GoalMutationOutcome =
	| { status: "created"; state: GoalState }
	| { status: "changed"; state: GoalState }
	| { status: "paused"; state: GoalState }
	| { status: "resumed"; state: GoalState }
	| { status: "cleared"; previousGoalId: string }
	| { status: "cancelled" }
	| { status: "unchanged"; state: GoalState; message: string }
	| { status: "error"; error: string };

export type GoalStartResult = "continued" | "skipped";

export type GoalBeforeSettleDecision =
	| { continue: true; content: string; details: GoalContinuationDetails }
	| { continue: false; autoPaused?: boolean };

export interface GoalManagerOptions {
	/** Persist a goal snapshot or cleared marker into the session. */
	persist: (entry: GoalState | GoalClearedMarker) => void;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
	/** Start an idle goal run immediately via a custom message with triggerTurn. */
	sendContinuation: (content: string, details: GoalContinuationDetails) => void;
	/** Called after any state or elapsed-time change so the host can refresh status UI. */
	onStateChange?: () => void;
	now?: () => number;
	maxConsecutiveIdleRounds?: number;
}

/** Per-call UI capabilities derived from an ExtensionContext or ExtensionCommandContext. */
export interface GoalUI {
	hasUI: boolean;
	/** Returns true when the user confirms, or when no UI is available. */
	requestConfirm: (title: string, message: string) => Promise<boolean>;
	/** Abort the current agent operation when replacing/pausing/clearing from a command. Omit in tool calls. */
	abort?: () => void;
	/** Wait for the aborted agent run to settle before starting a replacement goal. */
	waitForIdle?: () => Promise<void>;
	isStreaming: () => boolean;
}

export class GoalManager {
	private state: GoalState | null = null;
	private runStartedAtMs: number | null = null;
	private timeDirty = false;
	/**
	 * True when the goal left `active` (complete/blocked/paused) mid-run before
	 * `turn_end` / `agent_end`, so the remaining execution time of the current
	 * turn is still accrued once.
	 */
	private accountTerminalTurn = false;
	/** Prevents duplicate `startIfIdle` triggers before `onAgentStart` runs. */
	private startKicked = false;
	/** Suppresses continuation while an old streaming run is being aborted for replacement. */
	private replacing = false;
	/** True when at least one non-goal tool ran during the current agent loop. */
	private toolExecutedInRun = false;
	private consecutiveIdleRounds = 0;
	private autoPausedNote: string | undefined = undefined;

	private readonly persist: GoalManagerOptions["persist"];
	private readonly notify: GoalManagerOptions["notify"];
	private readonly sendContinuation: GoalManagerOptions["sendContinuation"];
	private readonly onStateChange: (() => void) | undefined;
	private readonly now: () => number;
	private readonly maxConsecutiveIdleRounds: number;

	constructor(options: GoalManagerOptions) {
		this.persist = options.persist;
		this.notify = options.notify;
		this.sendContinuation = options.sendContinuation;
		this.onStateChange = options.onStateChange;
		this.now = options.now ?? (() => Date.now());
		this.maxConsecutiveIdleRounds = options.maxConsecutiveIdleRounds ?? MAX_CONSECUTIVE_IDLE_ROUNDS;
	}

	/** Live goal snapshot with up-to-date active run time. */
	getState(now: number = this.now()): GoalState | null {
		if (!this.state) return null;
		const snapshot = cloneGoal(this.state);
		snapshot.timeUsedMs = this.elapsedTimeMs(now);
		return snapshot;
	}

	/** Active run time accumulated so far, including any currently running turn. */
	elapsedTimeMs(now: number = this.now()): number {
		if (!this.state) return 0;
		const liveDelta = this.runStartedAtMs !== null ? Math.max(0, now - this.runStartedAtMs) : 0;
		return this.state.timeUsedMs + liveDelta;
	}

	/** Restore the latest goal snapshot from the current session branch. */
	restore(entries: readonly SessionEntry[]): void {
		this.resetRuntime();
		this.state = loadGoalFromEntries(entries);
		this.onStateChange?.();
	}

	/** Tear down runtime timers/flags on session shutdown without touching UI. */
	shutdown(): void {
		this.resetRuntime();
	}

	/** Hidden context message injected before a run (active/paused goals only). */
	buildContextContent(now: number = this.now()): string | null {
		const state = this.state;
		if (!state) return null;
		if (state.status !== "active" && state.status !== "paused") return null;
		return buildGoalContextContent(state, this.elapsedTimeMs(now));
	}

	// =========================================================================
	// User commands & tool mutations
	// =========================================================================

	/**
	 * Create a new goal. Replacing an unfinished goal (active, paused, or
	 * blocked) requires confirmation. When invoked from a command while
	 * streaming, aborts the old run and waits for it to become idle first.
	 */
	async create(objective: string, ui: GoalUI): Promise<GoalMutationOutcome> {
		const trimmed = objective.trim();
		if (!trimmed) {
			const error = "Goal objective cannot be empty.";
			this.notify("Usage: /goal <objective>", "warning");
			return { status: "error", error };
		}
		if (trimmed.length > MAX_GOAL_OBJECTIVE_CHARS) {
			const error = `Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`;
			this.notify(error, "warning");
			return { status: "error", error };
		}

		const existing = this.state;
		const unfinished = existing !== null && isGoalUnfinished(existing.status);
		if (unfinished && existing) {
			const ok = await ui.requestConfirm(
				"Replace current goal?",
				`You have an unfinished goal:\n\n${existing.objective}\n\nReplace it with:\n\n${trimmed}`,
			);
			if (!ok) {
				this.notify("Goal creation cancelled.", "info");
				return { status: "cancelled" };
			}
			if (ui.isStreaming() && ui.abort) {
				this.replacing = true;
				try {
					ui.abort();
					if (ui.waitForIdle) {
						await ui.waitForIdle();
					}
				} finally {
					this.replacing = false;
				}
			}
		}

		const now = this.now();
		const stillStreaming = ui.isStreaming() && !ui.abort;
		this.resetRuntime();
		this.state = createGoalState(trimmed, now);
		if (stillStreaming) {
			// Created from an in-flight tool call: count the rest of this run and
			// do not treat the creation turn itself as an idle round.
			this.runStartedAtMs = now;
			this.toolExecutedInRun = true;
		}
		this.commit(this.state, `Goal created: ${trimmed}`, "info");
		return { status: "created", state: this.getState(now)! };
	}

	async clear(ui: GoalUI): Promise<GoalMutationOutcome> {
		const state = this.state;
		if (!state) {
			const error = "No goal to clear.";
			this.notify(error, "info");
			return { status: "error", error };
		}
		const ok = await ui.requestConfirm("Clear goal?", `Remove the current goal:\n\n${state.objective}`);
		if (!ok) {
			this.notify("Goal clear cancelled.", "info");
			return { status: "cancelled" };
		}
		const previousGoalId = state.goalId;
		this.state = null;
		this.resetRuntime();
		if (ui.isStreaming() && ui.abort) {
			ui.abort();
		}
		this.persist({ status: "cleared", clearedAt: this.now(), goalId: previousGoalId });
		this.notify("Goal cleared.");
		this.onStateChange?.();
		return { status: "cleared", previousGoalId };
	}

	pause(ui: GoalUI): GoalMutationOutcome {
		const state = this.state;
		if (!state) {
			const error = "No goal to pause.";
			this.notify(error, "info");
			return { status: "error", error };
		}
		if (state.status === "paused") {
			const message = "Goal is already paused.";
			this.notify(message, "info");
			return { status: "unchanged", state: this.getState()!, message };
		}
		if (state.status !== "active") {
			const error = `Cannot pause a goal in state "${state.status}".`;
			this.notify(error, "warning");
			return { status: "error", error };
		}

		const now = this.now();
		const willAbort = ui.isStreaming() && Boolean(ui.abort);
		this.flushActiveRunTime(state, now, willAbort);
		if (willAbort) {
			this.accountTerminalTurn = true;
			ui.abort?.();
		}
		this.startKicked = false;
		state.status = "paused";
		state.revision++;
		this.commit(state, "Goal paused.", "info");
		return { status: "paused", state: this.getState(now)! };
	}

	resume(): GoalMutationOutcome {
		const state = this.state;
		if (!state) {
			const error = "No goal to resume.";
			this.notify(error, "info");
			return { status: "error", error };
		}
		if (state.status === "active") {
			const message = "Goal is already active.";
			return { status: "unchanged", state: this.getState()!, message };
		}
		if (state.status === "complete") {
			const error = "Goal is already complete. Create a new goal with /goal <objective>.";
			this.notify(error, "info");
			return { status: "error", error };
		}

		state.status = "active";
		state.revision++;
		delete state.blockedReason;
		if (this.autoPausedNote && state.note === this.autoPausedNote) {
			delete state.note;
		}
		this.autoPausedNote = undefined;
		this.consecutiveIdleRounds = 0;
		this.commit(state, "Goal resumed.", "info");
		return { status: "resumed", state: this.getState()! };
	}

	edit(objective: string): GoalMutationOutcome {
		const state = this.state;
		if (!state) {
			const error = "No goal to edit. Create one with /goal <objective>.";
			this.notify(error, "warning");
			return { status: "error", error };
		}
		if (state.status === "complete") {
			const error = "Cannot edit a completed goal. Create a new goal with /goal <objective>.";
			this.notify(error, "warning");
			return { status: "error", error };
		}
		const trimmed = objective.trim();
		if (!trimmed) {
			const error = "Goal objective cannot be empty.";
			this.notify("Usage: /goal edit <objective>", "warning");
			return { status: "error", error };
		}
		if (trimmed.length > MAX_GOAL_OBJECTIVE_CHARS) {
			const error = `Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`;
			this.notify(error, "warning");
			return { status: "error", error };
		}
		if (trimmed === state.objective) {
			const message = "Goal objective is unchanged.";
			this.notify(message, "info");
			return { status: "unchanged", state: this.getState()!, message };
		}

		state.objective = trimmed;
		state.revision++;
		this.commit(state, `Goal updated: ${trimmed}`, "info");
		return { status: "changed", state: this.getState()! };
	}

	complete(note?: string): GoalMutationOutcome {
		const state = this.state;
		if (!state) {
			const error = "No goal is set.";
			this.notify(error, "warning");
			return { status: "error", error };
		}
		if (state.status === "complete") {
			const message = "Goal is already complete.";
			return { status: "unchanged", state: this.getState()!, message };
		}
		if (state.status !== "active") {
			const error = `Cannot mark goal complete while status is "${state.status}".`;
			this.notify(error, "warning");
			return { status: "error", error };
		}

		const now = this.now();
		const running = this.runStartedAtMs !== null;
		this.flushActiveRunTime(state, now, running);
		this.accountTerminalTurn = running;
		this.startKicked = false;
		state.status = "complete";
		state.completedAtMs = now;
		delete state.blockedReason;
		const trimmedNote = note?.trim();
		if (trimmedNote) state.note = trimmedNote;
		state.revision++;
		this.commit(state, "Goal complete - auto-continuation stopped.", "info");
		return { status: "changed", state: this.getState(now)! };
	}

	block(reason?: string): GoalMutationOutcome {
		const state = this.state;
		if (!state) {
			const error = "No goal is set.";
			this.notify(error, "warning");
			return { status: "error", error };
		}
		if (state.status === "blocked") {
			const message = "Goal is already blocked.";
			return { status: "unchanged", state: this.getState()!, message };
		}
		if (state.status !== "active") {
			const error = `Cannot mark goal blocked while status is "${state.status}".`;
			this.notify(error, "warning");
			return { status: "error", error };
		}

		const now = this.now();
		const running = this.runStartedAtMs !== null;
		this.flushActiveRunTime(state, now, running);
		this.accountTerminalTurn = running;
		this.startKicked = false;
		state.status = "blocked";
		const trimmedReason = reason?.trim();
		if (trimmedReason) state.blockedReason = trimmedReason;
		state.revision++;
		this.commit(state, "Goal blocked - auto-continuation stopped.", "warning");
		return { status: "changed", state: this.getState(now)! };
	}

	// =========================================================================
	// Agent lifecycle hooks
	// =========================================================================

	onUserPrompt(): void {
		this.consecutiveIdleRounds = 0;
	}

	onAgentStart(now: number = this.now()): void {
		this.startKicked = false;
		this.accountTerminalTurn = false;
		this.toolExecutedInRun = false;
		this.runStartedAtMs = this.state?.status === "active" ? now : null;
	}

	onToolExecutionStart(toolName: string): void {
		if (toolName !== "goal") {
			this.toolExecutedInRun = true;
		}
	}

	/**
	 * Accrue active run time at turn boundaries in memory without spamming
	 * session entries on every tool turn. Persists immediately only when closing
	 * a terminal turn (complete/blocked/paused mid-turn).
	 */
	onTurnEnd(now: number = this.now()): void {
		const state = this.state;
		if (!state) {
			this.runStartedAtMs = null;
			this.accountTerminalTurn = false;
			return;
		}

		const shouldAccount = state.status === "active" || this.accountTerminalTurn;
		if (!shouldAccount) {
			this.runStartedAtMs = null;
			return;
		}

		if (this.runStartedAtMs !== null) {
			const delta = Math.max(0, now - this.runStartedAtMs);
			if (delta > 0) {
				state.timeUsedMs += delta;
				this.timeDirty = true;
			}
			this.runStartedAtMs = state.status === "active" ? now : null;
		}

		if (this.accountTerminalTurn) {
			this.accountTerminalTurn = false;
			if (this.timeDirty) {
				this.timeDirty = false;
				state.updatedAt = now;
				this.persist(cloneGoal(state));
			}
		}

		this.onStateChange?.();
	}

	/** Finalize any remaining active run time and persist once when an agent loop ends. */
	onAgentEnd(now: number = this.now()): void {
		const state = this.state;
		if (state && this.runStartedAtMs !== null && (state.status === "active" || this.accountTerminalTurn)) {
			const delta = Math.max(0, now - this.runStartedAtMs);
			if (delta > 0) {
				state.timeUsedMs += delta;
				this.timeDirty = true;
			}
		}
		this.runStartedAtMs = null;
		this.accountTerminalTurn = false;

		if (state && this.timeDirty) {
			this.timeDirty = false;
			state.updatedAt = now;
			this.persist(cloneGoal(state));
			this.onStateChange?.();
		}
	}

	/**
	 * Decide at the `agent_before_settle` boundary whether to append a
	 * continuation message and keep the session loop running.
	 *
	 * Aborted runs never reach `agent_before_settle`; errored outcomes and runs
	 * with queued messages or existing continuations are skipped. Repeated rounds
	 * with no non-goal tool calls auto-pause the goal to prevent runaway loops.
	 */
	onBeforeSettle(opts: {
		outcome: "completed" | "aborted" | "error";
		hasPendingMessages: boolean;
		alreadyContinuing: boolean;
		includeObjective: boolean;
	}): GoalBeforeSettleDecision {
		const state = this.state;
		if (!state || state.status !== "active") return { continue: false };
		if (this.replacing) return { continue: false };
		if (opts.outcome !== "completed") return { continue: false };
		if (opts.hasPendingMessages || opts.alreadyContinuing) return { continue: false };

		if (this.toolExecutedInRun) {
			this.consecutiveIdleRounds = 0;
		} else {
			this.consecutiveIdleRounds++;
			if (this.consecutiveIdleRounds >= this.maxConsecutiveIdleRounds) {
				const reason = `Auto-paused after ${this.consecutiveIdleRounds} consecutive rounds without tool calls.`;
				this.autoPausedNote = reason;
				state.status = "paused";
				state.note = reason;
				state.revision++;
				this.commit(
					state,
					`Goal auto-paused after ${this.consecutiveIdleRounds} rounds with no tool activity. Run /goal resume to continue.`,
					"warning",
				);
				return { continue: false, autoPaused: true };
			}
		}

		const now = this.now();
		state.rounds++;
		state.updatedAt = now;
		this.timeDirty = false;
		this.persist(cloneGoal(state));
		this.onStateChange?.();

		const elapsed = this.elapsedTimeMs(now);
		const details: GoalContinuationDetails = {
			goalId: state.goalId,
			revision: state.revision,
			round: state.rounds,
			timeUsedMs: elapsed,
			objective: state.objective,
			kind: "continue",
		};
		const content = buildContinuationContent(state, {
			timeUsedMs: elapsed,
			round: state.rounds,
			includeObjective: opts.includeObjective,
			kind: "continue",
		});
		return { continue: true, content, details };
	}

	/**
	 * Kick off the first round immediately when the host is idle and nothing is
	 * queued. Used by `/goal <objective>` and `/goal resume`.
	 */
	startIfIdle(opts: {
		signalAborted: () => boolean;
		idle: () => boolean;
		hasPendingMessages: () => boolean;
	}): GoalStartResult {
		const state = this.state;
		if (!state || state.status !== "active") return "skipped";
		if (this.replacing || this.startKicked) return "skipped";
		if (opts.signalAborted()) return "skipped";
		if (!opts.idle()) return "skipped";
		if (opts.hasPendingMessages()) return "skipped";

		const now = this.now();
		this.startKicked = true;
		state.rounds++;
		state.updatedAt = now;
		this.timeDirty = false;
		this.persist(cloneGoal(state));
		this.onStateChange?.();

		const elapsed = this.elapsedTimeMs(now);
		const details: GoalContinuationDetails = {
			goalId: state.goalId,
			revision: state.revision,
			round: state.rounds,
			timeUsedMs: elapsed,
			objective: state.objective,
			kind: "start",
		};
		this.sendContinuation(
			buildContinuationContent(state, {
				timeUsedMs: elapsed,
				round: state.rounds,
				includeObjective: true,
				kind: "start",
			}),
			details,
		);
		return "continued";
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private resetRuntime(): void {
		this.runStartedAtMs = null;
		this.timeDirty = false;
		this.accountTerminalTurn = false;
		this.startKicked = false;
		this.replacing = false;
		this.toolExecutedInRun = false;
		this.consecutiveIdleRounds = 0;
	}

	private flushActiveRunTime(state: GoalState, now: number, keepRunningForTurnEnd: boolean): void {
		if (this.runStartedAtMs !== null) {
			const delta = Math.max(0, now - this.runStartedAtMs);
			if (delta > 0) {
				state.timeUsedMs += delta;
			}
			this.runStartedAtMs = keepRunningForTurnEnd ? now : null;
		}
		this.timeDirty = false;
	}

	private commit(state: GoalState, message?: string, type: "info" | "warning" | "error" = "info"): void {
		state.updatedAt = this.now();
		this.timeDirty = false;
		this.persist(cloneGoal(state));
		if (message) {
			this.notify(message, type);
		}
		this.onStateChange?.();
	}
}
