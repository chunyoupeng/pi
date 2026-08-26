/**
 * Unit tests for goal extension state helpers and formatting.
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
	parseGoalEditArgs,
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
			revision: 1,
			createdAt: 1000,
			activeSinceMs: 1000,
		});
		expect(state.goalId.length).toBeGreaterThan(0);
		expect(isGoalState(state)).toBe(true);
	});

	it("trims the objective on create", () => {
		expect(createGoalState("  spaced  ").objective).toBe("spaced");
	});

	it("validates malformed goal data", () => {
		expect(isGoalState(null)).toBe(false);
		expect(isGoalState({ version: 99 })).toBe(false);
		expect(isGoalState({ version: 1, goalId: "x", status: "bogus" })).toBe(false);
	});

	it("does not expose token budget fields in the state model", () => {
		const state = createGoalState("No budgets", 1000);
		expect(state).not.toHaveProperty("tokensUsed");
		expect(state).not.toHaveProperty("tokenBudget");
		expect(state).not.toHaveProperty("usageBaseline");
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

	it("returns null when entries carry no goal", () => {
		expect(loadGoalFromEntries([])).toBeNull();
		expect(loadGoalFromEntries([customEntry(undefined)])).toBeNull();
	});

	it("returns null when the latest goal entry is a cleared marker", () => {
		const state = createGoalState("Old", 10);
		const entries = [customEntry(state), customEntry({ status: "cleared", clearedAt: 20 })];
		expect(loadGoalFromEntries(entries)).toBeNull();
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

	it("parses goal edit arguments as the new objective", () => {
		expect(parseGoalEditArgs("new objective")).toBe("new objective");
		expect(parseGoalEditArgs("  spaced  ")).toBe("spaced");
		expect(parseGoalEditArgs("")).toBeNull();
		expect(parseGoalEditArgs("   ")).toBeNull();
	});

	it("builds hidden context containing objective/status/time as user data", () => {
		const state = createGoalState("Ship the feature", 100);
		const content = buildGoalContextContent(state);
		expect(content).toContain("Ship the feature");
		expect(content).toContain("active");
		expect(content).toContain("Time used:");
		expect(content).toContain("update_goal");
		expect(content).toContain("user-provided data");
		expect(content).not.toContain("Tokens used");
		expect(content).not.toContain("budget");
	});

	it("builds hidden context for paused goals without work instructions", () => {
		const state = createGoalState("Ship the feature", 100);
		state.status = "paused";
		const content = buildGoalContextContent(state);
		expect(content).toContain("paused");
		expect(content).toContain("Do not work toward it");
	});

	it("builds continuation content referencing the goal id", () => {
		const state = createGoalState("Ship the feature", 100);
		const content = buildContinuationContent(state);
		expect(content).toContain(state.goalId);
		expect(content).toContain("Ship the feature");
		expect(content).toContain('"complete"');
		expect(content).not.toContain("Tokens used");
		expect(content).not.toContain("budget");
	});
});
