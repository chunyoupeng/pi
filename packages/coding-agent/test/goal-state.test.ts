/**
 * Unit tests for goal extension state helpers, command parsing, and prompt builders.
 */

import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	buildContinuationContent,
	buildGoalContextContent,
	createGoalState,
	formatDuration,
	GOAL_CUSTOM_TYPE,
	isGoalClearedMarker,
	isGoalState,
	loadGoalFromEntries,
	MAX_GOAL_OBJECTIVE_CHARS,
	parseGoalCommand,
} from "../src/extensions/goal/state.ts";

function customEntry(data: unknown, overrides: Partial<SessionEntry> = {}): SessionEntry {
	return {
		type: "custom",
		customType: GOAL_CUSTOM_TYPE,
		data,
		id: overrides.id ?? Math.random().toString(36).slice(2, 10),
		parentId: null,
		timestamp: new Date().toISOString(),
	} as SessionEntry;
}

describe("goal state helpers", () => {
	it("creates an active goal with defaults", () => {
		const state = createGoalState("Fix the parser", 1000);
		expect(state).toMatchObject({
			version: 1,
			status: "active",
			objective: "Fix the parser",
			timeUsedMs: 0,
			rounds: 0,
			revision: 1,
			createdAt: 1000,
			updatedAt: 1000,
		});
		expect(state.goalId.length).toBeGreaterThan(0);
		expect(isGoalState(state)).toBe(true);
	});

	it("trims the objective on create", () => {
		expect(createGoalState("  spaced  ").objective).toBe("spaced");
	});

	it("validates malformed goal data and objective length", () => {
		expect(isGoalState(null)).toBe(false);
		expect(isGoalState({ version: 99 })).toBe(false);
		expect(isGoalState({ version: 1, goalId: "x", status: "bogus" })).toBe(false);

		const overlong = { ...createGoalState("ok", 100), objective: "a".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1) };
		expect(isGoalState(overlong)).toBe(false);
	});

	it("loads legacy persisted snapshots missing rounds and normalizes them", () => {
		const legacy = {
			version: 1,
			goalId: "legacy123",
			revision: 2,
			status: "active",
			objective: "Legacy goal",
			createdAt: 10,
			updatedAt: 20,
			timeUsedMs: 500,
			activeSinceMs: 15,
		};
		const loaded = loadGoalFromEntries([customEntry(legacy)]);
		expect(loaded).toEqual({
			version: 1,
			goalId: "legacy123",
			revision: 2,
			status: "active",
			objective: "Legacy goal",
			createdAt: 10,
			updatedAt: 20,
			timeUsedMs: 500,
			rounds: 0,
		});
	});

	it("detects cleared markers", () => {
		expect(isGoalClearedMarker({ status: "cleared", clearedAt: 1 })).toBe(true);
		expect(isGoalClearedMarker({ status: "active" })).toBe(false);
	});

	it("loads the latest goal from branch entries", () => {
		const first = createGoalState("First", 10);
		const second = createGoalState("Second", 20);
		const entries = [customEntry(first), customEntry(second)];
		expect(loadGoalFromEntries(entries)?.objective).toBe("Second");
	});

	it("returns null when entries carry no goal or end in cleared marker", () => {
		expect(loadGoalFromEntries([])).toBeNull();
		expect(loadGoalFromEntries([customEntry(undefined)])).toBeNull();
		const state = createGoalState("Old", 10);
		expect(loadGoalFromEntries([customEntry(state), customEntry({ status: "cleared", clearedAt: 20 })])).toBeNull();
	});

	it("keeps scanning older entries when the newest one is malformed", () => {
		const state = createGoalState("Valid", 10);
		const entries = [customEntry(state), customEntry({ bogus: true })];
		expect(loadGoalFromEntries(entries)?.objective).toBe("Valid");
	});

	it("formats duration values", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(90_000)).toBe("1m 30s");
		expect(formatDuration(3_600_000)).toBe("1h 0m");
	});
});

describe("parseGoalCommand", () => {
	it("parses exact zero-argument subcommands", () => {
		expect(parseGoalCommand("")).toEqual({ kind: "show" });
		expect(parseGoalCommand("   ")).toEqual({ kind: "show" });
		expect(parseGoalCommand("show")).toEqual({ kind: "show" });
		expect(parseGoalCommand("STATUS")).toEqual({ kind: "show" });
		expect(parseGoalCommand("pause")).toEqual({ kind: "pause" });
		expect(parseGoalCommand("resume")).toEqual({ kind: "resume" });
		expect(parseGoalCommand("clear")).toEqual({ kind: "clear" });
	});

	it("does not hijack natural-language objectives starting with zero-arg subcommands", () => {
		expect(parseGoalCommand("clear unused imports in src/")).toEqual({
			kind: "create",
			objective: "clear unused imports in src/",
		});
		expect(parseGoalCommand("show progress bar in footer")).toEqual({
			kind: "create",
			objective: "show progress bar in footer",
		});
		expect(parseGoalCommand("status page redesign")).toEqual({
			kind: "create",
			objective: "status page redesign",
		});
		expect(parseGoalCommand("pause background jobs during compaction")).toEqual({
			kind: "create",
			objective: "pause background jobs during compaction",
		});
		expect(parseGoalCommand("resume failed downloads automatically")).toEqual({
			kind: "create",
			objective: "resume failed downloads automatically",
		});
	});

	it("parses edit and explicit set subcommands", () => {
		expect(parseGoalCommand("edit")).toEqual({ kind: "edit", objective: null });
		expect(parseGoalCommand("edit   ")).toEqual({ kind: "edit", objective: null });
		expect(parseGoalCommand("edit New objective")).toEqual({ kind: "edit", objective: "New objective" });
		expect(parseGoalCommand("set edit config loader")).toEqual({ kind: "create", objective: "edit config loader" });
		expect(parseGoalCommand("set pause")).toEqual({ kind: "create", objective: "pause" });
	});
});

describe("goal prompt builders", () => {
	it("builds hidden context referencing the unified goal tool", () => {
		const state = createGoalState("Ship the feature", 100);
		const content = buildGoalContextContent(state, 5000);
		expect(content).toContain("Ship the feature");
		expect(content).toContain("active");
		expect(content).toContain("Time used: 5s");
		expect(content).toContain('action="complete"');
		expect(content).toContain('action="blocked"');
		expect(content).toContain("user-provided data");
		expect(content).not.toContain("update_goal");
	});

	it("builds hidden context for paused goals without work instructions", () => {
		const state = createGoalState("Ship the feature", 100);
		state.status = "paused";
		const content = buildGoalContextContent(state);
		expect(content).toContain("paused");
		expect(content).toContain("Do not work toward it");
	});

	it("builds full and compact continuation prompts appropriately", () => {
		const state = createGoalState("Ship the feature", 100);
		const full = buildContinuationContent(state, {
			timeUsedMs: 1000,
			round: 1,
			includeObjective: true,
			kind: "start",
		});
		expect(full).toContain(state.goalId);
		expect(full).toContain("Ship the feature");
		expect(full).toContain("round #1");
		expect(full).toContain('action="complete"');

		const compact = buildContinuationContent(state, {
			timeUsedMs: 12_000,
			round: 3,
			includeObjective: false,
			kind: "continue",
		});
		expect(compact).toContain(state.goalId);
		expect(compact).toContain("round #3");
		expect(compact).toContain("12s");
		expect(compact).not.toContain("Ship the feature");
	});
});
