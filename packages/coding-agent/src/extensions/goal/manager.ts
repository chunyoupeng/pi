/**
 * Goal extension - goal controller.
 *
 * Encapsulates goal lifecycle: create/replace, pause/resume/clear/edit,
 * completion via tools, per-turn time accounting, and guarded
 * auto-continuation on agent settle. Kept free of pi/ctx references so it can
 * be unit tested with fakes; `index.ts` wires it to the extension API. The
 * goal tracks wall-clock time only; it never enforces token or resource
 * budgets.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "../../core/session-manager.ts";
import { sleep } from "../../utils/sleep.ts";
import {
	buildContinuationContent,
	buildGoalContextContent,
	createGoalState,
	formatDuration,
	GOAL_CONTINUATION_DELAY_MS,
	type GoalClearedMarker,
	type GoalState,
	isGoalUnfinished,
	loadGoalFromEntries,
	MAX_GOAL_OBJECTIVE_CHARS,
} from "./state.ts";

export type GoalMutationResult = "created" | "changed" | "cleared" | "paused" | "resumed" | "cancelled" | "noop";

export type GoalSettleResult = "continued" | "skipped";

export interface GoalManagerOptions {
	/** Persist a goal snapshot or cleared marker into the session. */
	persist: (entry: GoalState | GoalClearedMarker) => void;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
	/** Schedule the next auto-continuation round (hidden custom message). */
	sendContinuation: (content: string, details: { goalId: string; revision: number }) => void;
	/** Called after any mutation so the host can refresh the footer/status. */
	onStateChange?: () => void;
	/** Injectable delay for settle-time continuation (tests). */
	delay?: (ms: number) => Promise<void>;
	now?: () => number;
}

/** Per-call UI that commands/tools derive from an ExtensionContext. */
export interface GoalUI {
	hasUI: boolean;
	/** Returns true when the user confirms, or when no UI is available. */
	requestConfirm: (title: string, message: string) => Promise<boolean>;
	/** Abort the current agent operation (used when goals are replaced/cleared). */
	abort: () => void;
	isStreaming: () => boolean;
}

export class GoalManager {
	private state: GoalState | null = null;
	private continuationScheduled = false;
	/**
	 * True when the goal was flipped to a terminal status (complete/blocked)
	 * during the current turn, before `turn_end`. The completing turn's time
	 * must still be accrued even though the state is no longer active.
	 */
	private accountTerminalTurn = false;
	private readonly persist: GoalManagerOptions["persist"];
	private readonly notify: GoalManagerOptions["notify"];
	private readonly sendContinuation: GoalManagerOptions["sendContinuation"];
	private readonly onStateChange: (() => void) | undefined;
	private readonly delay: (ms: number) => Promise<void>;
	private readonly now: () => number;

	constructor(options: GoalManagerOptions) {
		this.persist = options.persist;
		this.notify = options.notify;
		this.sendContinuation = options.sendContinuation;
		this.onStateChange = options.onStateChange;
		this.delay = options.delay ?? ((ms) => sleep(ms));
		this.now = options.now ?? (() => Date.now());
	}

	getState(): GoalState | null {
		return this.state ? { ...this.state } : null;
	}

	/** Restore the latest goal snapshot from the current session branch. */
	restore(entries: readonly SessionEntry[]): void {
		// Reset any scheduled continuation and stale mid-turn accounting from
		// the previous runtime/session.
		this.continuationScheduled = false;
		this.accountTerminalTurn = false;
		this.state = loadGoalFromEntries(entries);
		// Don't count downtime between process restarts against the goal.
		if (this.state?.status === "active") {
			this.state.activeSinceMs = this.now();
		}
		this.onStateChange?.();
	}

	getStatusText(): string | undefined {
		const state = this.state;
		if (!state) return undefined;
		const objective = state.objective.length > 22 ? `${state.objective.slice(0, 21)}…` : state.objective;
		return `🎯 ${objective} · ${state.status}`;
	}

	formatSummary(now: number = this.now()): string {
		const state = this.state;
		if (!state) {
			return "No goal is set. Create one with /goal <objective>.";
		}
		const totalTime = this.elapsedTimeMs(state, now);
		const lines = [
			`Goal: ${state.objective}`,
			`Goal ID: ${state.goalId} (revision ${state.revision})`,
			`Status: ${state.status}`,
			`Time used: ${formatDuration(totalTime)}`,
			`Created: ${new Date(state.createdAt).toLocaleString()}`,
			`Updated: ${new Date(state.updatedAt).toLocaleString()}`,
		];
		if (state.completedAtMs !== undefined) {
			lines.push(`Completed: ${new Date(state.completedAtMs).toLocaleString()}`);
		}
		if (state.note) lines.push(`Note: ${state.note}`);
		if (state.blockedReason) lines.push(`Blocked reason: ${state.blockedReason}`);
		return lines.join("\n");
	}

	/** Context injected before each user round (active/paused goals only). */
	buildContextContent(): string | null {
		const state = this.state;
		if (!state) return null;
		if (state.status !== "active" && state.status !== "paused") return null;
		return buildGoalContextContent(state);
	}

	// =========================================================================
	// User commands & tools
	// =========================================================================

	/**
	 * Create a new goal. Replacing an unfinished goal (active, paused, or
	 * blocked) requires confirmation and aborts any in-flight work toward the
	 * old goal.
	 */
	async create(objective: string, ui: GoalUI): Promise<GoalMutationResult> {
		const trimmed = objective.trim();
		if (!trimmed) {
			this.notify("Usage: /goal <objective>", "warning");
			return "noop";
		}
		if (trimmed.length > MAX_GOAL_OBJECTIVE_CHARS) {
			this.notify(`Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`, "warning");
			return "noop";
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
				return "cancelled";
			}
			// Stop any in-flight work toward the old goal.
			if (ui.isStreaming()) ui.abort();
		}
		const now = this.now();
		this.state = createGoalState(trimmed, now);
		this.continuationScheduled = false;
		this.commit(this.state, `Goal created: ${trimmed}`, "info");
		return "created";
	}

	async clear(ui: GoalUI): Promise<GoalMutationResult> {
		const state = this.state;
		if (!state) {
			this.notify("No goal to clear.", "info");
			return "noop";
		}
		const ok = await ui.requestConfirm("Clear goal?", `Remove the current goal:\n\n${state.objective}`);
		if (!ok) {
			this.notify("Goal clear cancelled.", "info");
			return "cancelled";
		}
		if (ui.isStreaming()) ui.abort();
		this.state = null;
		this.continuationScheduled = false;
		this.persist({ status: "cleared", clearedAt: this.now(), goalId: state.goalId });
		this.notify("Goal cleared.");
		this.onStateChange?.();
		return "cleared";
	}

	pause(ui: GoalUI): GoalMutationResult {
		const state = this.state;
		if (!state) {
			this.notify("No goal to pause.", "info");
			return "noop";
		}
		if (state.status === "paused") {
			this.notify("Goal is already paused.", "info");
			return "noop";
		}
		if (state.status !== "active") {
			this.notify(`Cannot pause a goal in state "${state.status}".`, "warning");
			return "noop";
		}
		// Abort the current run; the final accounting pass for the aborted turn
		// (if any) is handled by onTurnEnd via accountTerminalTurn.
		const wasStreaming = ui.isStreaming();
		if (wasStreaming) {
			this.accountTerminalTurn = true;
			ui.abort();
		}
		this.finalizeActivePeriod(state, this.now());
		state.status = "paused";
		this.commit(state, "Goal paused.", "info");
		return "paused";
	}

	resume(_ui: GoalUI): GoalMutationResult {
		const state = this.state;
		if (!state) {
			this.notify("No goal to resume.", "info");
			return "noop";
		}
		if (state.status === "active") {
			this.notify("Goal is already active.", "info");
			return "noop";
		}
		if (state.status === "complete") {
			this.notify("Goal is already complete.", "info");
			return "noop";
		}
		state.status = "active";
		state.activeSinceMs = this.now();
		this.commit(state, "Goal resumed.", "info");
		return "resumed";
	}

	edit(objective: string, _ui: GoalUI): GoalMutationResult {
		const state = this.state;
		if (!state) {
			this.notify("No goal to edit. Create one with /goal <objective>.", "warning");
			return "noop";
		}
		if (objective === state.objective) {
			this.notify("Nothing to edit. Usage: /goal edit <objective>", "info");
			return "noop";
		}
		state.objective = objective;
		state.revision++;
		this.commit(state, `Goal updated (objective "${objective}").`, "info");
		return "changed";
	}

	complete(note: string | undefined, _ui: GoalUI): GoalMutationResult {
		const state = this.state;
		if (!state) {
			this.notify("No goal to complete.", "warning");
			return "noop";
		}
		if (state.status === "complete") {
			this.notify("Goal is already complete.", "info");
			return "noop";
		}
		if (state.status !== "active") {
			this.notify(`Cannot complete a goal in state "${state.status}".`, "warning");
			return "noop";
		}
		const wasActive = state.status === "active";
		if (wasActive) {
			this.finalizeActivePeriod(state, this.now());
			this.accountTerminalTurn = true;
		}
		state.status = "complete";
		state.completedAtMs = this.now();
		state.note = note?.trim() || state.note;
		state.revision++;
		this.commit(state, "Goal complete - objective achieved. Auto-continuation stopped.", "info");
		return "changed";
	}

	block(reason: string | undefined, _ui: GoalUI): GoalMutationResult {
		const state = this.state;
		if (!state) {
			this.notify("No goal to block.", "warning");
			return "noop";
		}
		if (state.status === "blocked") {
			this.notify("Goal is already blocked.", "info");
			return "noop";
		}
		if (state.status !== "active") {
			this.notify(`Cannot block a goal in state "${state.status}".`, "warning");
			return "noop";
		}
		const wasActive = state.status === "active";
		if (wasActive) {
			this.finalizeActivePeriod(state, this.now());
			this.accountTerminalTurn = true;
		}
		state.status = "blocked";
		state.blockedReason = reason?.trim() || state.blockedReason;
		state.revision++;
		this.commit(state, "Goal blocked - auto-continuation stopped.", "warning");
		return "changed";
	}

	// =========================================================================
	// Agent lifecycle accounting
	// =========================================================================

	onAgentStart(): void {
		// A new run started (user prompt or continuation): allow future settles
		// to schedule the next continuation and close any stale mid-turn
		// terminal accounting from an interrupted previous run.
		this.continuationScheduled = false;
		this.accountTerminalTurn = false;
	}

	/**
	 * Per-turn running-time accounting. Only counted while the goal is active,
	 * so pre-goal and post-completion session time never lands in the goal.
	 */
	onTurnEnd(now: number = this.now()): void {
		const state = this.state;
		if (!state) return;

		// Account the turn that flipped the goal to a terminal status
		// (complete/blocked via a tool call before turn_end) so its time is not
		// lost once the status is no longer active.
		const shouldAccount = state.status === "active" || this.accountTerminalTurn;
		if (!shouldAccount) return;

		// Running time: accumulate the period since the previous turn end.
		if (state.activeSinceMs !== undefined) {
			state.timeUsedMs += Math.max(0, now - state.activeSinceMs);
			state.activeSinceMs = state.status === "active" ? now : undefined;
		}

		state.updatedAt = now;
		this.accountTerminalTurn = false;
		this.commit(state);
	}

	/**
	 * Decide whether to schedule the next auto-continuation round.
	 * Runs after the agent has fully settled: goal active, idle, no queued
	 * messages, no abort, no duplicate scheduling, and no error from the last
	 * assistant message.
	 */
	async onAgentSettled(opts: {
		signalAborted: () => boolean;
		idle: () => boolean;
		hasPendingMessages: () => boolean;
		lastAssistantHasError: () => boolean;
	}): Promise<GoalSettleResult> {
		const state = this.state;
		if (!state || state.status !== "active") return "skipped";
		if (opts.signalAborted()) return "skipped";
		if (!opts.idle()) return "skipped";
		if (opts.hasPendingMessages()) return "skipped";
		if (this.continuationScheduled) return "skipped";
		if (opts.lastAssistantHasError()) return "skipped";

		// Brief delay so a user prompt submitted right after settling wins.
		await this.delay(GOAL_CONTINUATION_DELAY_MS);

		// Re-check everything - the user may have paused/cleared/replaced the
		// goal or submitted new input while we waited.
		const current = this.state;
		if (!current || current.status !== "active") return "skipped";
		if (current.goalId !== state.goalId || current.revision !== state.revision) return "skipped";
		if (opts.signalAborted()) return "skipped";
		if (!opts.idle()) return "skipped";
		if (opts.hasPendingMessages()) return "skipped";

		this.continuationScheduled = true;
		this.sendContinuation(buildContinuationContent(current), {
			goalId: current.goalId,
			revision: current.revision,
		});
		return "continued";
	}

	/**
	 * Start the first goal round immediately when the host is idle and nothing
	 * else is queued. Used by commands (`/goal <objective>`, `/goal resume`, …)
	 * so a goal created/resumed while the agent sits idle actually starts
	 * working right away instead of waiting for a settle event. When the agent
	 * is streaming or messages are pending, this returns "skipped" and the
	 * regular `agent_settled` path schedules the continuation later.
	 */
	startIfIdle(opts: {
		signalAborted: () => boolean;
		idle: () => boolean;
		hasPendingMessages: () => boolean;
	}): GoalSettleResult {
		const state = this.state;
		if (!state || state.status !== "active") return "skipped";
		if (opts.signalAborted()) return "skipped";
		if (!opts.idle()) return "skipped";
		if (opts.hasPendingMessages()) return "skipped";
		if (this.continuationScheduled) return "skipped";

		this.continuationScheduled = true;
		this.sendContinuation(buildContinuationContent(state), {
			goalId: state.goalId,
			revision: state.revision,
		});
		return "continued";
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private elapsedTimeMs(state: GoalState, now: number): number {
		let total = state.timeUsedMs;
		if (state.status === "active" && state.activeSinceMs !== undefined) {
			total += Math.max(0, now - state.activeSinceMs);
		}
		return total;
	}

	private finalizeActivePeriod(state: GoalState, now: number): void {
		if (state.status === "active" && state.activeSinceMs !== undefined) {
			state.timeUsedMs += Math.max(0, now - state.activeSinceMs);
			state.activeSinceMs = now;
		}
	}

	private commit(state: GoalState, message?: string, type: "info" | "warning" | "error" = "info"): void {
		state.updatedAt = this.now();
		this.persist(state);
		if (message) {
			this.notify(message, type);
		}
		this.onStateChange?.();
	}
}

/** True when the most recent assistant message on the branch ended in an error. */
export function lastAssistantMessageHasError(entries: readonly SessionEntry[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return (entry.message as AssistantMessage).stopReason === "error";
	}
	return false;
}
