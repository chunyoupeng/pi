/**
 * Unit tests for the goal controller (lifecycle, time accounting, auto-continuation).
 */

import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { GoalManager, type GoalUI, lastAssistantMessageHasError } from "../src/extensions/goal/manager.ts";
import { createGoalState, type GoalClearedMarker, type GoalState } from "../src/extensions/goal/state.ts";

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
	continuations: Array<{ content: string; details: { goalId: string; revision: number } }>;
	setTime: (t: number) => void;
}

function setupManager(
	initialEntries: SessionEntry[] = [],
	startTime = 10_000,
	delay: (ms: number) => Promise<void> = async () => {},
): ManagerHarness {
	const persisted: Array<GoalState | GoalClearedMarker> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const continuations: Array<{ content: string; details: { goalId: string; revision: number } }> = [];
	let currentTime = startTime;
	const manager = new GoalManager({
		persist: (entry) => persisted.push(entry),
		notify: (message, type) => notifications.push({ message, type }),
		sendContinuation: (content, details) => continuations.push({ content, details }),
		delay,
		now: () => currentTime,
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

function settleOptions(overrides: Partial<Parameters<GoalManager["onAgentSettled"]>[0]> = {}) {
	return {
		signalAborted: () => false,
		idle: () => true,
		hasPendingMessages: () => false,
		lastAssistantHasError: () => false,
		...overrides,
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
	it("restores null without entries", () => {
		const { manager } = setupManager([]);
		expect(manager.getState()).toBeNull();
	});

	it("restores the latest snapshot from the branch", () => {
		const state = createGoalState("Restore me", 5000);
		const { manager } = setupManager([goalEntry(state, "e1")], 9000);
		expect(manager.getState()?.objective).toBe("Restore me");
		// Active goals reset their clock on restore (no downtime counted).
		expect(manager.getState()?.activeSinceMs).toBe(9000);
	});

	it("restores null after a cleared marker", () => {
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
		const { manager } = setupManager(entries);
		expect(manager.getState()).toBeNull();
	});
});

describe("GoalManager commands", () => {
	it("creates an active goal and persists it", async () => {
		const { manager, persisted } = setupManager([], 1000);
		const result = await manager.create("  Fix login  ", noopUi);
		expect(result).toBe("created");
		const state = manager.getState();
		expect(state?.status).toBe("active");
		expect(state?.objective).toBe("Fix login");
		expect(state?.timeUsedMs).toBe(0);
		expect(persisted[persisted.length - 1]).toMatchObject({ status: "active", objective: "Fix login" });
	});

	it("requires confirmation when replacing an unfinished goal", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("First goal", noopUi);
		const originalId = manager.getState()?.goalId;
		const confirm = vi.fn(async () => false);
		const cancelled = await manager.create("Second goal", { ...noopUi, hasUI: true, requestConfirm: confirm });
		expect(cancelled).toBe("cancelled");
		expect(manager.getState()?.objective).toBe("First goal");
		expect(manager.getState()?.goalId).toBe(originalId);

		confirm.mockResolvedValueOnce(true);
		const replaced = await manager.create("Second goal", { ...noopUi, hasUI: true, requestConfirm: confirm });
		expect(replaced).toBe("created");
		expect(manager.getState()?.objective).toBe("Second goal");
	});

	it("treats a blocked goal as unfinished and requires confirmation to replace (Codex semantics)", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("Blocked goal", noopUi);
		manager.block("missing credentials", noopUi);
		expect(manager.getState()?.status).toBe("blocked");

		const confirm = vi.fn(async () => false);
		const cancelled = await manager.create("New goal", { ...noopUi, hasUI: true, requestConfirm: confirm });
		expect(cancelled).toBe("cancelled");
		expect(manager.getState()?.objective).toBe("Blocked goal");

		confirm.mockResolvedValueOnce(true);
		const replaced = await manager.create("New goal", { ...noopUi, hasUI: true, requestConfirm: confirm });
		expect(replaced).toBe("created");
		expect(manager.getState()?.objective).toBe("New goal");
		expect(manager.getState()?.status).toBe("active");
	});

	it("replaces without confirmation when there is no unfinished goal", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("First", noopUi);
		const confirm = vi.fn(async () => false);
		await manager.complete("done", noopUi);
		const result = await manager.create("Second", { ...noopUi, hasUI: true, requestConfirm: confirm });
		expect(result).toBe("created");
		expect(manager.getState()?.objective).toBe("Second");
		expect(confirm).not.toHaveBeenCalled();
	});

	it("aborts the current run when replacing a streaming goal", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("First", noopUi);
		const abort = vi.fn();
		await manager.create("Second", { ...noopUi, isStreaming: () => true, abort });
		expect(abort).toHaveBeenCalled();
	});

	it("pauses, resumes, and clears", async () => {
		const { manager, persisted } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		expect(manager.pause(noopUi)).toBe("paused");
		expect(manager.getState()?.status).toBe("paused");
		expect(manager.resume(noopUi)).toBe("resumed");
		expect(manager.getState()?.status).toBe("active");
		const cleared = await manager.clear(noopUi);
		expect(cleared).toBe("cleared");
		expect(manager.getState()).toBeNull();
		expect(persisted[persisted.length - 1]).toMatchObject({ status: "cleared" });
	});

	it("clears only after confirmation when UI is present", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		const confirm = vi.fn(async () => false);
		const result = await manager.clear({ ...noopUi, hasUI: true, requestConfirm: confirm });
		expect(result).toBe("cancelled");
		expect(manager.getState()?.objective).toBe("Goal");
	});

	it("edits the objective, bumping revision", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("Old objective", noopUi);
		const before = manager.getState()!;
		const result = manager.edit("New objective", noopUi);
		expect(result).toBe("changed");
		const after = manager.getState()!;
		expect(after.objective).toBe("New objective");
		expect(after.objective).not.toBe("Old objective");
		expect(after.revision).toBe(before.revision + 1);
	});

	it("treats an identical objective edit as a noop", async () => {
		const { manager } = setupManager([], 1000);
		await manager.create("Same", noopUi);
		expect(manager.edit("Same", noopUi)).toBe("noop");
	});
});

describe("GoalManager time accounting", () => {
	it("accumulates running time across turns and finalizes on pause", async () => {
		const { manager, setTime } = setupManager([], 10_000);
		await manager.create("Goal", noopUi);
		setTime(11_000);
		manager.onTurnEnd(11_000); // +1000ms
		setTime(11_500);
		manager.onTurnEnd(11_500); // +500ms
		expect(manager.getState()?.timeUsedMs).toBe(1500);
		setTime(12_000);
		manager.pause(noopUi);
		expect(manager.getState()?.timeUsedMs).toBe(2000);
		// Time doesn't accrue while paused.
		setTime(99_000);
		manager.resume(noopUi);
		setTime(99_500);
		manager.complete("done", noopUi);
		expect(manager.getState()?.timeUsedMs).toBe(2500);
	});

	it("accrues the completing turn's time, then stops after completion", async () => {
		const { manager, setTime } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		setTime(2000);
		manager.onTurnEnd(2000); // +1000ms
		// complete/blocked is a tool call that happens mid-turn, before turn_end.
		manager.complete("done", noopUi);
		// The rest of the completing turn's time is still charged to the goal.
		setTime(3000);
		manager.onTurnEnd(3000); // +1000ms
		expect(manager.getState()?.timeUsedMs).toBe(2000);
		// Later turns are not charged to a completed goal.
		manager.onAgentStart();
		setTime(4000);
		manager.onTurnEnd(4000);
		expect(manager.getState()?.timeUsedMs).toBe(2000);
	});

	it("accrues the turn time when the goal is blocked mid-turn", async () => {
		const { manager, setTime } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		manager.block("missing API key", noopUi);
		setTime(2000);
		manager.onTurnEnd(2000); // +1000ms
		expect(manager.getState()?.timeUsedMs).toBe(1000);
		// Subsequent turns are not charged to a blocked goal.
		manager.onAgentStart();
		setTime(3000);
		manager.onTurnEnd(3000);
		expect(manager.getState()?.timeUsedMs).toBe(1000);
	});

	it("does not accrue time without a goal or after clearing", async () => {
		const { manager, setTime } = setupManager([], 1000);
		manager.onTurnEnd(2000);
		expect(manager.getState()).toBeNull();
		await manager.create("Goal", noopUi);
		await manager.clear(noopUi);
		setTime(3000);
		manager.onTurnEnd(3000);
		expect(manager.getState()).toBeNull();
	});
});

describe("GoalManager auto-continuation", () => {
	it("continues once when active, idle, and no queues/pending/abort", async () => {
		const { manager, continuations } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		const result = await manager.onAgentSettled(settleOptions());
		expect(result).toBe("continued");
		expect(continuations).toHaveLength(1);
		expect(continuations[0]?.details.revision).toBe(1);
		expect(continuations[0]?.content).toContain("Goal");
	});

	it("does not double-schedule without an intervening agent start", async () => {
		const { manager, continuations } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		// First settle schedules; a duplicate settle in the same window is ignored.
		const first = await manager.onAgentSettled(settleOptions());
		const second = await manager.onAgentSettled(settleOptions());
		expect(first).toBe("continued");
		expect(second).toBe("skipped");
		expect(continuations).toHaveLength(1);
		// After the continuation run starts, the next settle schedules again.
		manager.onAgentStart();
		const third = await manager.onAgentSettled(settleOptions());
		expect(third).toBe("continued");
		expect(continuations).toHaveLength(2);
	});

	it("does not continue after pause, complete, or blocked", async () => {
		const { manager, continuations } = setupManager([], 1000);

		await manager.create("Paused", noopUi);
		manager.pause(noopUi);
		expect(await manager.onAgentSettled(settleOptions())).toBe("skipped");
		manager.resume(noopUi);

		manager.complete("done", noopUi);
		expect(await manager.onAgentSettled(settleOptions())).toBe("skipped");
		expect(continuations).toHaveLength(0);

		// A blocked goal after a fresh create also never continues.
		const blockedGoal = setupManager([], 2000);
		await blockedGoal.manager.create("Blocked", noopUi);
		blockedGoal.manager.block("missing api key", noopUi);
		expect(await blockedGoal.manager.onAgentSettled(settleOptions())).toBe("skipped");
		expect(blockedGoal.continuations).toHaveLength(0);
	});

	it("does not continue when the run was aborted", async () => {
		const { manager, continuations } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		const result = await manager.onAgentSettled(settleOptions({ signalAborted: () => true }));
		expect(result).toBe("skipped");
		expect(continuations).toHaveLength(0);
	});

	it("does not continue when messages are pending or the agent is not idle", async () => {
		const { manager, continuations } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		expect(await manager.onAgentSettled(settleOptions({ hasPendingMessages: () => true }))).toBe("skipped");
		expect(await manager.onAgentSettled(settleOptions({ idle: () => false }))).toBe("skipped");
		expect(continuations).toHaveLength(0);
	});

	it("does not continue after an errored assistant message", async () => {
		const { manager, continuations } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		const result = await manager.onAgentSettled(settleOptions({ lastAssistantHasError: () => true }));
		expect(result).toBe("skipped");
		expect(continuations).toHaveLength(0);
	});

	it("rejects a stale goal (paused during the settle delay)", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { manager, continuations } = setupManager([], 1000, () => gate);
		await manager.create("Goal", noopUi);

		const settle = manager.onAgentSettled(settleOptions());
		// The user pauses the goal while the continuation is waiting.
		manager.pause(noopUi);
		release?.();
		expect(await settle).toBe("skipped");
		expect(continuations).toHaveLength(0);
	});

	it("rejects a stale goal (replaced during the settle delay)", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { manager, continuations } = setupManager([], 1000, () => gate);
		await manager.create("Original", noopUi);
		const originalId = manager.getState()?.goalId;

		const settle = manager.onAgentSettled(settleOptions());
		// The user replaces the goal while the continuation is waiting.
		await manager.create("Replacement", noopUi);
		expect(manager.getState()?.goalId).not.toBe(originalId);
		release?.();
		expect(await settle).toBe("skipped");
		expect(continuations).toHaveLength(0);
	});
});

describe("GoalManager startIfIdle", () => {
	it("kicks the first round immediately when active and idle", async () => {
		const { manager, continuations } = setupManager([], 1000);
		await manager.create("Goal", noopUi);
		const result = manager.startIfIdle({
			signalAborted: () => false,
			idle: () => true,
			hasPendingMessages: () => false,
		});
		expect(result).toBe("continued");
		expect(continuations).toHaveLength(1);
		expect(continuations[0]?.details.revision).toBe(1);
		expect(continuations[0]?.content).toContain("Goal");
	});

	it("skips when not idle, queued, aborted, non-active, or already scheduled", async () => {
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
		expect(continuations).toHaveLength(0);

		// The first successful kick schedules; a duplicate is ignored.
		expect(manager.startIfIdle(opts)).toBe("continued");
		expect(manager.startIfIdle(opts)).toBe("skipped");
		expect(continuations).toHaveLength(1);

		// Completed goals never kick.
		manager.complete("done", noopUi);
		expect(manager.startIfIdle(opts)).toBe("skipped");
		expect(continuations).toHaveLength(1);

		// A blocked goal is also not kicked.
		const blockedHarness = setupManager([], 2000);
		await blockedHarness.manager.create("Blocked", noopUi);
		blockedHarness.manager.block("nope", noopUi);
		expect(blockedHarness.manager.startIfIdle(opts)).toBe("skipped");
		expect(blockedHarness.continuations).toHaveLength(0);
	});
});

describe("lastAssistantMessageHasError", () => {
	it("detects an errored last assistant message", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "",
				message: { role: "assistant", stopReason: "stop" },
			},
			{
				type: "message",
				id: "a2",
				parentId: "a1",
				timestamp: "",
				message: { role: "assistant", stopReason: "error" },
			},
		] as unknown as SessionEntry[];
		expect(lastAssistantMessageHasError(entries)).toBe(true);
		expect(
			lastAssistantMessageHasError([
				{
					type: "message",
					id: "a3",
					parentId: null,
					timestamp: "",
					message: { role: "assistant", stopReason: "stop" },
				},
			] as unknown as SessionEntry[]),
		).toBe(false);
		expect(lastAssistantMessageHasError([])).toBe(false);
	});
});
