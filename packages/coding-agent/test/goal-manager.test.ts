/**
 * Unit tests for GoalManager (lifecycle, active run timing, idle-loop guard,
 * and `agent_before_settle` continuation decisions).
 */

import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { GoalManager, type GoalUI } from "../src/extensions/goal/manager.ts";
import {
	createGoalState,
	type GoalClearedMarker,
	type GoalContinuationDetails,
	type GoalState,
	MAX_GOAL_OBJECTIVE_CHARS,
} from "../src/extensions/goal/state.ts";

const noopUi: GoalUI = {
	hasUI: false,
	requestConfirm: async () => true,
	abort: () => {},
	isStreaming: () => false,
};

interface ManagerHarness {
	manager: GoalManager;
	persisted: Array<GoalState | GoalClearedMarker>;
	notifications: Array<{ message: string; type?: string }>;
	continuations: Array<{ content: string; details: GoalContinuationDetails }>;
	setTime: (t: number) => void;
}

function setupManager(
	initialEntries: SessionEntry[] = [],
	startTime = 10_000,
	maxConsecutiveIdleRounds?: number,
): ManagerHarness {
	const persisted: Array<GoalState | GoalClearedMarker> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const continuations: Array<{ content: string; details: GoalContinuationDetails }> = [];
	let currentTime = startTime;
	const manager = new GoalManager({
		persist: (entry) => persisted.push(entry),
		notify: (message, type) => notifications.push({ message, type }),
		sendContinuation: (content, details) => continuations.push({ content, details }),
		now: () => currentTime,
		maxConsecutiveIdleRounds,
	});
	manager.restore(initialEntries);
	return {
		manager,
		persisted,
		notifications,
		continuations,
		setTime: (t) => {
			currentTime = t;
		},
	};
}

function goalEntry(state: GoalState, id = "g1"): SessionEntry {
	return {
		type: "custom",
		customType: "goal",
		data: state,
		id,
		parentId: null,
		timestamp: "",
	} as unknown as SessionEntry;
}

describe("GoalManager state restoration", () => {
	it("restores null without entries or after a cleared marker", () => {
		expect(setupManager([]).manager.getState()).toBeNull();

		const state = createGoalState("Old", 5000);
		const entries = [
			goalEntry(state, "e1"),
			{
				type: "custom",
				customType: "goal",
				data: { status: "cleared", clearedAt: 6000 },
				id: "e2",
				parentId: "e1",
				timestamp: "",
			},
		] as unknown as SessionEntry[];
		expect(setupManager(entries).manager.getState()).toBeNull();
	});

	it("restores the latest snapshot without counting idle time before an agent run", () => {
		const state = createGoalState("Restore me", 5000);
		state.timeUsedMs = 1200;
		const { manager, setTime } = setupManager([goalEntry(state, "e1")], 9000);
		setTime(99_000);
		expect(manager.getState()?.objective).toBe("Restore me");
		expect(manager.elapsedTimeMs()).toBe(1200);
	});
});

describe("GoalManager mutations", () => {
	it("creates an active goal and rejects empty or overlong objectives with explicit errors", async () => {
		const { manager, persisted } = setupManager([], 1000);

		const empty = await manager.create("   ", noopUi);
		expect(empty).toMatchObject({ status: "error" });

		const tooLong = await manager.create("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1), noopUi);
		expect(tooLong).toMatchObject({ status: "error" });

		const created = await manager.create("  Fix login  ", noopUi);
		expect(created.status).toBe("created");
		expect(manager.getState()).toMatchObject({ status: "active", objective: "Fix login", timeUsedMs: 0, rounds: 0 });
		expect(persisted[persisted.length - 1]).toMatchObject({ status: "active", objective: "Fix login" });
	});

	it("requires confirmation when replacing active, paused, or blocked goals, but not complete goals", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("First goal", noopUi);
		const confirm = vi.fn(async () => false);

		expect((await manager.create("Second", { ...noopUi, hasUI: true, requestConfirm: confirm })).status).toBe(
			"cancelled",
		);
		expect(manager.getState()?.objective).toBe("First goal");

		manager.block("missing key");
		expect((await manager.create("Second", { ...noopUi, hasUI: true, requestConfirm: confirm })).status).toBe(
			"cancelled",
		);

		manager.resume();
		manager.complete("done");
		confirm.mockClear();
		const replaced = await manager.create("Third", { ...noopUi, hasUI: true, requestConfirm: confirm });
		expect(replaced.status).toBe("created");
		expect(confirm).not.toHaveBeenCalled();
	});

	it("aborts and awaits idle when replacing a streaming goal from a command", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("First", noopUi);
		const events: string[] = [];
		const abort = vi.fn(() => events.push("abort"));
		const waitForIdle = vi.fn(async () => {
			events.push("waitForIdle");
		});
		const result = await manager.create("Second", {
			...noopUi,
			isStreaming: () => true,
			abort,
			waitForIdle,
		});
		expect(result.status).toBe("created");
		expect(events).toEqual(["abort", "waitForIdle"]);
		expect(manager.getState()?.objective).toBe("Second");
	});

	it("bumps revision on pause, resume, edit, complete, and block", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		expect(manager.getState()?.revision).toBe(1);

		expect(manager.pause(noopUi).status).toBe("paused");
		expect(manager.getState()?.revision).toBe(2);

		expect(manager.resume().status).toBe("resumed");
		expect(manager.getState()?.revision).toBe(3);

		expect(manager.edit("Updated goal").status).toBe("changed");
		expect(manager.getState()?.revision).toBe(4);

		expect(manager.block("waiting").status).toBe("changed");
		expect(manager.getState()?.revision).toBe(5);
		expect(manager.getState()?.blockedReason).toBe("waiting");

		expect(manager.resume().status).toBe("resumed");
		expect(manager.getState()?.revision).toBe(6);
		expect(manager.getState()?.blockedReason).toBeUndefined();

		expect(manager.complete("done").status).toBe("changed");
		expect(manager.getState()?.revision).toBe(7);
	});

	it("validates edit length and disallows editing completed goals", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("Initial", noopUi);

		expect(manager.edit("   ").status).toBe("error");
		expect(manager.edit("a".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1)).status).toBe("error");
		expect(manager.edit("Initial").status).toBe("unchanged");

		manager.complete("done");
		expect(manager.edit("After complete").status).toBe("error");
		expect(manager.getState()?.objective).toBe("Initial");
	});

	it("rejects complete/block when goal is paused or in another non-active state", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		manager.pause(noopUi);

		const completePaused = manager.complete("done");
		expect(completePaused).toMatchObject({ status: "error" });
		const blockPaused = manager.block("stuck");
		expect(blockPaused).toMatchObject({ status: "error" });
	});
});

describe("GoalManager active run time accounting", () => {
	it("counts only active agent run time and ignores idle gaps between runs", async () => {
		const { manager, persisted, setTime } = setupManager([], 10_000);
		await manager.create("Goal", noopUi);
		const persistCountAfterCreate = persisted.length;

		// Idle for 1 hour before any run starts: 0ms accrued.
		setTime(3_610_000);
		expect(manager.elapsedTimeMs()).toBe(0);

		// Run 1 with two internal tool turns (1000ms + 500ms).
		manager.onAgentStart(3_610_000);
		setTime(3_611_000);
		manager.onTurnEnd(3_611_000);
		// Does not spam JSONL persistence on every intermediate turn_end.
		expect(persisted.length).toBe(persistCountAfterCreate);

		setTime(3_611_500);
		manager.onTurnEnd(3_611_500);
		manager.onAgentEnd(3_611_500);
		expect(manager.getState()?.timeUsedMs).toBe(1500);
		expect(persisted.length).toBe(persistCountAfterCreate + 1);

		// Idle gap between runs is NOT charged.
		setTime(9_000_000);
		expect(manager.elapsedTimeMs()).toBe(1500);
	});

	it("accrues the completing/blocking turn's time, then stops after completion", async () => {
		const { manager, setTime } = setupManager([], 1000);
		await manager.create("Goal", noopUi);

		manager.onAgentStart(2000);
		setTime(3000);
		manager.complete("done"); // +1000ms so far
		setTime(3500);
		manager.onTurnEnd(3500); // +500ms remainder of completing turn
		manager.onAgentEnd(3500);
		expect(manager.getState()?.timeUsedMs).toBe(1500);

		// Subsequent runs on a completed goal do not accrue time.
		manager.onAgentStart(5000);
		setTime(8000);
		manager.onTurnEnd(8000);
		manager.onAgentEnd(8000);
		expect(manager.getState()?.timeUsedMs).toBe(1500);
	});
});

describe("GoalManager onBeforeSettle and idle-loop protection", () => {
	it("continues on completed outcome and skips aborted, errored, pending, or already-continuing runs", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		manager.onAgentStart(1000);
		manager.onToolExecutionStart("read");

		expect(
			manager.onBeforeSettle({
				outcome: "aborted",
				hasPendingMessages: false,
				alreadyContinuing: false,
				includeObjective: false,
			}),
		).toEqual({ continue: false });

		expect(
			manager.onBeforeSettle({
				outcome: "error",
				hasPendingMessages: false,
				alreadyContinuing: false,
				includeObjective: false,
			}),
		).toEqual({ continue: false });

		expect(
			manager.onBeforeSettle({
				outcome: "completed",
				hasPendingMessages: true,
				alreadyContinuing: false,
				includeObjective: false,
			}),
		).toEqual({ continue: false });

		expect(
			manager.onBeforeSettle({
				outcome: "completed",
				hasPendingMessages: false,
				alreadyContinuing: true,
				includeObjective: false,
			}),
		).toEqual({ continue: false });

		const decision = manager.onBeforeSettle({
			outcome: "completed",
			hasPendingMessages: false,
			alreadyContinuing: false,
			includeObjective: false,
		});
		expect(decision.continue).toBe(true);
		if (decision.continue) {
			expect(decision.details.round).toBe(1);
			expect(decision.details.kind).toBe("continue");
		}
	});

	it("auto-pauses after consecutive rounds without non-goal tool calls and resets on real tool work", async () => {
		const { manager } = setupManager([], 1000, 3);
		await manager.create("Goal", noopUi);

		// Round 1: no tools
		manager.onAgentStart(1000);
		expect(
			manager.onBeforeSettle({
				outcome: "completed",
				hasPendingMessages: false,
				alreadyContinuing: false,
				includeObjective: false,
			}).continue,
		).toBe(true);

		// Round 2: only called `goal` tool (does not count as work)
		manager.onAgentStart(2000);
		manager.onToolExecutionStart("goal");
		expect(
			manager.onBeforeSettle({
				outcome: "completed",
				hasPendingMessages: false,
				alreadyContinuing: false,
				includeObjective: false,
			}).continue,
		).toBe(true);

		// Round 3: real tool work resets idle counter
		manager.onAgentStart(3000);
		manager.onToolExecutionStart("bash");
		expect(
			manager.onBeforeSettle({
				outcome: "completed",
				hasPendingMessages: false,
				alreadyContinuing: false,
				includeObjective: false,
			}).continue,
		).toBe(true);

		// Three consecutive idle rounds trigger auto-pause
		for (let i = 0; i < 2; i++) {
			manager.onAgentStart(4000 + i * 1000);
			expect(
				manager.onBeforeSettle({
					outcome: "completed",
					hasPendingMessages: false,
					alreadyContinuing: false,
					includeObjective: false,
				}).continue,
			).toBe(true);
		}
		manager.onAgentStart(6000);
		const thirdIdle = manager.onBeforeSettle({
			outcome: "completed",
			hasPendingMessages: false,
			alreadyContinuing: false,
			includeObjective: false,
		});
		expect(thirdIdle).toEqual({ continue: false, autoPaused: true });
		expect(manager.getState()?.status).toBe("paused");
		expect(manager.getState()?.note).toContain("Auto-paused");

		// Resuming clears auto-pause note and resets idle counter
		expect(manager.resume().status).toBe("resumed");
		expect(manager.getState()?.status).toBe("active");
		expect(manager.getState()?.note).toBeUndefined();
	});

	it("starts immediately via startIfIdle and deduplicates before agent_start", async () => {
		const { manager, continuations } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		const opts = {
			signalAborted: () => false,
			idle: () => true,
			hasPendingMessages: () => false,
		};
		expect(manager.startIfIdle({ ...opts, idle: () => false })).toBe("skipped");
		expect(manager.startIfIdle({ ...opts, hasPendingMessages: () => true })).toBe("skipped");
		expect(manager.startIfIdle({ ...opts, signalAborted: () => true })).toBe("skipped");

		expect(manager.startIfIdle(opts)).toBe("continued");
		expect(manager.startIfIdle(opts)).toBe("skipped");
		expect(continuations).toHaveLength(1);
		expect(continuations[0]?.details.kind).toBe("start");
		expect(continuations[0]?.details.round).toBe(1);
		expect(continuations[0]?.content).toContain("Goal");
	});
});
