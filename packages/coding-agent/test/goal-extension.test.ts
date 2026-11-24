/**
 * Integration tests for the goal built-in extension:
 * unified `goal` tool, `/goal` command parsing and editor support,
 * `agent_before_settle` auto-continuation, compaction/tree/shutdown handling,
 * print-mode settlement, and UI renderers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import goalExtension from "../src/extensions/goal/index.ts";
import {
	renderGoalContinuationMessage,
	renderGoalFooterStatus,
	renderGoalSummary,
	renderGoalToolCall,
	renderGoalToolResult,
} from "../src/extensions/goal/render.ts";
import {
	createGoalState,
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTINUATION_CUSTOM_TYPE,
	GOAL_CUSTOM_TYPE,
	type GoalContinuationDetails,
	MAX_GOAL_OBJECTIVE_CHARS,
} from "../src/extensions/goal/state.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

type Handler = (...args: unknown[]) => unknown;

const stubTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

interface Harness {
	handlers: Map<string, Handler>;
	tools: Map<string, any>;
	commands: Map<string, any>;
	entries: Array<{ type: string; data: unknown }>;
	sent: Array<{ msg: { customType: string; content: string; display: boolean; details?: unknown }; opts: unknown }>;
	messageRenderers: Map<string, unknown>;
	makeCtx: (branch: SessionEntry[], opts?: Record<string, unknown>) => ExtensionContext;
}

function setup(): Harness {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const sent: Array<{
		msg: { customType: string; content: string; display: boolean; details?: unknown };
		opts: unknown;
	}> = [];
	const messageRenderers = new Map<string, unknown>();

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		sendMessage: (msg: { customType: string; content: string; display: boolean; details?: unknown }, opts: unknown) =>
			sent.push({ msg, opts }),
		registerMessageRenderer: (type: string, renderer: unknown) => messageRenderers.set(type, renderer),
	} as unknown as ExtensionAPI;

	goalExtension(pi);

	const makeCtx = (branchArg: SessionEntry[], opts: Record<string, unknown> = {}): ExtensionContext => {
		const ctx = {
			mode: opts.mode ?? "tui",
			hasUI: opts.hasUI ?? false,
			ui: {
				notify: vi.fn(),
				confirm: vi.fn(async () => opts.confirmResult ?? true),
				editor: vi.fn(async () => opts.editorResult),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				theme: stubTheme,
			},
			sessionManager: { getBranch: () => branchArg },
			signal: opts.signal as AbortSignal | undefined,
			isIdle: () => (typeof opts.idle === "function" ? (opts.idle as () => boolean)() : (opts.idle ?? true)),
			hasPendingMessages: () => opts.pending ?? false,
			abort: opts.abort ?? vi.fn(),
			waitForIdle: opts.waitForIdle ?? vi.fn(async () => {}),
			isProjectTrusted: () => true,
			cwd: "/tmp",
		} as unknown as ExtensionContext;
		return ctx;
	};

	return {
		handlers,
		tools,
		commands,
		entries,
		sent,
		messageRenderers,
		makeCtx,
	};
}

function entriesToBranch(h: Harness): SessionEntry[] {
	return h.entries.map((entry, index) => ({
		type: "custom",
		customType: GOAL_CUSTOM_TYPE,
		data: entry.data,
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date().toISOString(),
	})) as unknown as SessionEntry[];
}

async function runCommand(h: Harness, args: string, ctx: ExtensionContext): Promise<void> {
	await h.commands.get("goal")!.handler(args, ctx);
}

function runTool(h: Harness, params: Record<string, unknown>, ctx: ExtensionContext): Promise<any> {
	return h.tools.get("goal")!.execute("call-1", params, undefined, undefined, ctx);
}

function goalFromEntries(h: Harness): any | null {
	for (let i = h.entries.length - 1; i >= 0; i--) {
		const data = h.entries[i]?.data;
		if (data && typeof data === "object" && (data as { status?: string }).status !== "cleared") {
			return data;
		}
		if (data && typeof data === "object" && (data as { status?: string }).status === "cleared") {
			return null;
		}
	}
	return null;
}

function beforeSettleEvent(overrides: Record<string, unknown> = {}) {
	return {
		type: "agent_before_settle",
		outcome: "completed",
		entries: [],
		continue: false,
		context: {
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: true,
		},
		...overrides,
	};
}

describe("goal extension wiring", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("registers a single unified goal tool, command, message renderer, and lifecycle hooks", () => {
		const h = setup();
		expect([...h.tools.keys()]).toEqual(["goal"]);
		expect(h.commands.has("goal")).toBe(true);
		expect(h.messageRenderers.has(GOAL_CONTINUATION_CUSTOM_TYPE)).toBe(true);
		for (const event of [
			"session_start",
			"session_tree",
			"session_compact",
			"session_shutdown",
			"before_agent_start",
			"agent_start",
			"tool_execution_start",
			"turn_end",
			"agent_end",
			"agent_before_settle",
			"agent_settled",
		]) {
			expect(h.handlers.has(event)).toBe(true);
		}
	});
});

describe("unified goal tool", () => {
	it("supports get, create, complete, and blocked with accurate validation and errors", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { idle: false });

		const emptyGet = await runTool(h, { action: "get" }, ctx);
		expect(emptyGet.content[0].text).toBe("null");
		expect(emptyGet.details).toEqual({ action: "get", goal: null });

		// Empty and overlong objectives report real errors instead of "cancelled".
		const missingObj = await runTool(h, { action: "create", objective: "   " }, ctx);
		expect(missingObj.isError).toBe(true);
		expect(missingObj.content[0].text).toContain("objective");

		const overlongObj = await runTool(
			h,
			{ action: "create", objective: "x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1) },
			ctx,
		);
		expect(overlongObj.isError).toBe(true);
		expect(overlongObj.content[0].text).toContain(String(MAX_GOAL_OBJECTIVE_CHARS));

		const created = await runTool(h, { action: "create", objective: "Refactor parser" }, ctx);
		expect(created.isError).toBeFalsy();
		const goalId = goalFromEntries(h).goalId;

		// Unfinished goal refuses overwrite without flag.
		const refused = await runTool(h, { action: "create", objective: "Another", overwrite: false }, ctx);
		expect(refused.isError).toBe(true);
		expect(goalFromEntries(h).objective).toBe("Refactor parser");

		// Mismatched goalId fails.
		const mismatch = await runTool(h, { action: "complete", goalId: "wrong-id" }, ctx);
		expect(mismatch.isError).toBe(true);

		// Calling complete on a paused goal returns an actual error (not "already paused; no change").
		await runCommand(h, "pause", ctx);
		const completePaused = await runTool(h, { action: "complete", goalId }, ctx);
		expect(completePaused.isError).toBe(true);
		expect(completePaused.content[0].text).toContain('Cannot mark goal complete while status is "paused"');

		await runCommand(h, "resume", ctx);
		const blocked = await runTool(h, { action: "blocked", goalId, note: "missing API key" }, ctx);
		expect(blocked.isError).toBeFalsy();
		expect(goalFromEntries(h).status).toBe("blocked");
		expect(goalFromEntries(h).blockedReason).toBe("missing API key");

		// Overwrite replaces blocked goal when explicitly requested.
		const replaced = await runTool(h, { action: "create", objective: "Second goal", overwrite: true }, ctx);
		expect(replaced.isError).toBeFalsy();
		const secondId = goalFromEntries(h).goalId;

		const completed = await runTool(h, { action: "complete", goalId: secondId, note: "verified" }, ctx);
		expect(completed.isError).toBeFalsy();
		expect(goalFromEntries(h).status).toBe("complete");
		expect(goalFromEntries(h).note).toBe("verified");
	});
});

describe("/goal command", () => {
	it("creates goals whose objectives start with zero-arg subcommand words", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { idle: false });
		await runCommand(h, "clear unused imports in src/", ctx);
		expect(goalFromEntries(h)?.objective).toBe("clear unused imports in src/");
		expect(goalFromEntries(h)?.status).toBe("active");
	});

	it("opens ctx.ui.editor for /goal edit without arguments", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: true, idle: false, editorResult: "Edited via modal" });
		await runCommand(h, "Original objective", ctx);
		await runCommand(h, "edit", ctx);
		expect(ctx.ui.editor).toHaveBeenCalledWith("Edit goal objective", "Original objective");
		expect(goalFromEntries(h)?.objective).toBe("Edited via modal");
	});

	it("aborts and waits for idle before starting a replacement goal while streaming", async () => {
		const h = setup();
		let streaming = true;
		const order: string[] = [];
		const ctx = h.makeCtx([], {
			hasUI: true,
			confirmResult: true,
			idle: () => !streaming,
			abort: vi.fn(() => order.push("abort")),
			waitForIdle: vi.fn(async () => {
				order.push("waitForIdle");
				streaming = false;
			}),
		});

		// Create initial goal while streaming (does not kick immediately).
		await runCommand(h, "Old goal", ctx);
		expect(h.sent).toHaveLength(0);

		// Replace while still streaming: aborts, waits until idle, then kicks new goal.
		await runCommand(h, "New goal", ctx);
		expect(order).toEqual(["abort", "waitForIdle"]);
		expect(goalFromEntries(h)?.objective).toBe("New goal");
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.msg.content).toContain("New goal");
	});

	it("waits for idle in print mode when starting a goal via /goal <objective>", async () => {
		const h = setup();
		const waitForIdle = vi.fn(async () => {});
		const ctx = h.makeCtx([], { mode: "print", idle: true, waitForIdle });
		await runCommand(h, "Finish task", ctx);
		expect(h.sent).toHaveLength(1);
		expect(waitForIdle).toHaveBeenCalledTimes(1);
	});
});

describe("goal lifecycle hooks", () => {
	it("auto-continues via agent_before_settle, skips aborted/errored runs, and avoids repeating objective", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { idle: true });
		await runCommand(h, "Build the feature", ctx);

		// Start continuation message carries full objective; before_agent_start deduplicates it.
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.msg.display).toBe(true);
		const skipDup = await h.handlers.get("before_agent_start")!(
			{ messageType: "custom", message: h.sent[0]?.msg },
			ctx,
		);
		expect(skipDup).toBeUndefined();

		// Round 1 with real tool call completes -> agent_before_settle returns compact continuation.
		await h.handlers.get("agent_start")!({}, ctx);
		await h.handlers.get("tool_execution_start")!({ toolName: "bash" }, ctx);
		const cont1 = (await h.handlers.get("agent_before_settle")!(beforeSettleEvent(), ctx)) as any;
		expect(cont1?.continue).toBe(true);
		expect(cont1.entries).toHaveLength(1);
		expect(cont1.entries[0].customType).toBe(GOAL_CONTINUATION_CUSTOM_TYPE);
		expect(cont1.entries[0].display).toBe(true);
		expect(cont1.entries[0].content).not.toContain("Build the feature");

		// Aborted or errored outcome must NEVER continue.
		expect(
			await h.handlers.get("agent_before_settle")!(beforeSettleEvent({ outcome: "aborted" }), ctx),
		).toBeUndefined();
		expect(
			await h.handlers.get("agent_before_settle")!(beforeSettleEvent({ outcome: "error" }), ctx),
		).toBeUndefined();
	});

	it("re-injects full objective after session_compact", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { idle: false });
		await runCommand(h, "Survive compaction", ctx);

		const first = (await h.handlers.get("before_agent_start")!({ messageType: "user", prompt: "go" }, ctx)) as any;
		expect(first.message.customType).toBe(GOAL_CONTEXT_CUSTOM_TYPE);
		expect(first.message.content).toContain("Survive compaction");

		// Second turn does not duplicate.
		expect(await h.handlers.get("before_agent_start")!({ messageType: "user", prompt: "more" }, ctx)).toBeUndefined();

		// Compaction clears the injected key so the next round re-injects full objective.
		await h.handlers.get("session_compact")!({ type: "session_compact" }, ctx);
		const afterCompact = (await h.handlers.get("before_agent_start")!(
			{ messageType: "user", prompt: "after compact" },
			ctx,
		)) as any;
		expect(afterCompact.message.content).toContain("Survive compaction");
	});

	it("restores state on session_tree without auto-starting, and allows /goal resume to kick off", async () => {
		const h = setup();
		const setupCtx = h.makeCtx([], { idle: false });
		await runCommand(h, "Branch goal", setupCtx);
		const branch = entriesToBranch(h);

		const treeCtx = h.makeCtx(branch, { idle: true });
		await h.handlers.get("session_tree")!({ type: "session_tree" }, treeCtx);
		expect(h.sent).toHaveLength(0);
		expect(treeCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/goal resume"), "info");

		// Explicit /goal resume kicks off the restored active goal while idle.
		await runCommand(h, "resume", treeCtx);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.msg.content).toContain("Branch goal");
	});
});

describe("goal UI renderers", () => {
	it("renders footer status without emojis and includes status, time, rounds, and preview", () => {
		const state = createGoalState("Refactor the parser cleanly", 1000);
		state.rounds = 2;
		const status = renderGoalFooterStatus(state, 65_000, stubTheme);
		expect(status).toContain("goal:");
		expect(status).toContain("active");
		expect(status).toContain("1m 5s");
		expect(status).toContain("r2");
		expect(status).toContain("Refactor the parser cleanly");
		expect(status).not.toContain("🎯");
		expect(renderGoalFooterStatus(null, 0, stubTheme)).toBeUndefined();
	});

	it("renders summary card, tool calls/results, and continuation banner", () => {
		const state = createGoalState("Ship v2", 1000);
		state.rounds = 3;
		const summary = renderGoalSummary(state, 12_000, stubTheme);
		expect(summary).toContain("Ship v2");
		expect(summary).toContain("Rounds:");
		expect(summary).toContain("/goal pause");

		const callLines = renderGoalToolCall(
			{ action: "create", objective: "Ship v2", overwrite: true },
			stubTheme,
		).render(100);
		expect(callLines.join("\n")).toContain('goal create "Ship v2" (overwrite)');

		const okLines = renderGoalToolResult(
			{ content: [], details: { action: "complete", goal: { ...state, status: "complete", note: "all green" } } },
			{ expanded: false },
			stubTheme,
		).render(100);
		expect(okLines.join("\n")).toContain("Goal complete");
		expect(okLines.join("\n")).toContain("all green");

		const errLines = renderGoalToolResult(
			{ content: [], details: { action: "create", error: "Goal objective cannot be empty." } },
			{ expanded: false },
			stubTheme,
		).render(100);
		expect(errLines.join("\n")).toContain("Error: Goal objective cannot be empty.");

		const details: GoalContinuationDetails = {
			goalId: state.goalId,
			revision: 1,
			round: 2,
			timeUsedMs: 15_000,
			objective: "Ship v2",
			kind: "continue",
		};
		const renderOpts = (expanded: boolean) => ({
			expanded,
			outputPad: 1,
			keyText: () => "ctrl+o",
			keyHint: (_action: string, desc: string) => `(ctrl+o ${desc})`,
		});
		const banner = renderGoalContinuationMessage(
			{
				role: "custom",
				customType: GOAL_CONTINUATION_CUSTOM_TYPE,
				content: "Full prompt body",
				display: true,
				details,
				timestamp: 2000,
			},
			renderOpts(false),
			stubTheme,
		);
		expect(banner?.render(100).join("\n")).toContain("round #2");
		expect(banner?.render(100).join("\n")).not.toContain("Full prompt body");

		const expandedBanner = renderGoalContinuationMessage(
			{
				role: "custom",
				customType: GOAL_CONTINUATION_CUSTOM_TYPE,
				content: "Full prompt body",
				display: true,
				details,
				timestamp: 2000,
			},
			renderOpts(true),
			stubTheme,
		);
		expect(expandedBanner?.render(100).join("\n")).toContain("Full prompt body");
	});
});
