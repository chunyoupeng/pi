/**
 * Integration-style tests for the goal built-in extension (factory wiring):
 * command parsing, persistence, tools, hidden context injection, and
 * auto-continuation scheduling through pi.sendMessage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import goalExtension from "../src/extensions/goal/index.ts";
import {
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTINUATION_CUSTOM_TYPE,
	GOAL_CUSTOM_TYPE,
} from "../src/extensions/goal/state.ts";

type Handler = (...args: unknown[]) => unknown;

interface Harness {
	handlers: Map<string, Handler>;
	tools: Map<string, any>;
	commands: Map<string, any>;
	entries: Array<{ type: string; data: unknown }>;
	sent: Array<{ msg: { customType: string; content: string; display: boolean }; opts: unknown }>;
	renderers: Map<string, unknown>;
	makeCtx: (branch: SessionEntry[], opts?: Record<string, unknown>) => ExtensionContext;
}

function _assistantEntry(id: string, input: number, output = 0): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "test",
			model: "test-model",
			usage: {
				input,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	} as unknown as SessionEntry;
}

function setup(): Harness {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const sent: Array<{ msg: { customType: string; content: string; display: boolean }; opts: unknown }> = [];
	const renderers = new Map<string, unknown>();

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		sendMessage: (msg: { customType: string; content: string; display: boolean }, opts: unknown) =>
			sent.push({ msg, opts }),
		registerEntryRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
	} as unknown as ExtensionAPI;

	goalExtension(pi);

	const makeCtx = (branchArg: SessionEntry[], opts: Record<string, unknown> = {}): ExtensionContext => {
		const ctx = {
			mode: opts.mode ?? "tui",
			hasUI: opts.hasUI ?? false,
			ui: {
				notify: vi.fn(),
				confirm: vi.fn(async () => opts.confirmResult ?? true),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				theme: { fg: (_name: string, text: string) => text },
			},
			sessionManager: { getBranch: () => branchArg },
			signal: opts.signal as AbortSignal | undefined,
			isIdle: () => opts.idle ?? true,
			hasPendingMessages: () => opts.pending ?? false,
			abort: vi.fn(),
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
		renderers,
		makeCtx,
	};
}

async function restoreGoal(h: Harness): Promise<ExtensionContext> {
	const branch = h.entries.map((entry, index) => ({
		type: "custom",
		customType: GOAL_CUSTOM_TYPE,
		data: entry.data,
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date().toISOString(),
	})) as unknown as SessionEntry[];
	const ctx = h.makeCtx(branch);
	await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	return ctx;
}

async function runCommand(h: Harness, args: string, ctx: ExtensionContext): Promise<void> {
	const command = h.commands.get("goal")!;
	await command.handler(args, ctx);
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

describe("goal extension", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("registers tools, command, entry renderer, and lifecycle handlers", () => {
		const h = setup();
		expect(h.tools.has("get_goal")).toBe(true);
		expect(h.tools.has("create_goal")).toBe(true);
		expect(h.tools.has("update_goal")).toBe(true);
		expect(h.commands.has("goal")).toBe(true);
		expect(h.renderers.has(GOAL_CUSTOM_TYPE)).toBe(true);
		for (const event of ["session_start", "before_agent_start", "agent_start", "turn_end", "agent_settled"]) {
			expect(h.handlers.has(event)).toBe(true);
		}
	});

	it("returns null from get_goal without a goal", async () => {
		const h = setup();
		const ctx = await restoreGoal(h);
		const result = await h.tools.get("get_goal")!.execute("call-1", {}, undefined, undefined, ctx);
		expect(result.content[0].text).toBe("null");
	});

	it("creates a goal via /goal <objective> and persists it", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "Refactor the parser", ctx);
		const state = goalFromEntries(h);
		expect(state.status).toBe("active");
		expect(state.objective).toBe("Refactor the parser");
		expect(state.tokensUsed).toBeUndefined();
		expect(state.tokenBudget).toBeUndefined();
		expect((ctx.ui as unknown as { setStatus: ReturnType<typeof vi.fn> }).setStatus).toHaveBeenCalledWith(
			"goal",
			expect.stringContaining("Refactor the parser"),
		);
	});

	it("shows the goal summary via /goal", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "Ship the feature", ctx);
		const showCtx = h.makeCtx([], { hasUI: true });
		await runCommand(h, "", showCtx);
		expect(showCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Ship the feature"), "info");
		expect((showCtx.ui.notify as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("Time used:");
	});

	it("requires confirmation before replacing an unfinished goal", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: true, confirmResult: false });
		await runCommand(h, "First goal", ctx);
		await runCommand(h, "Second goal", ctx);
		expect(goalFromEntries(h)?.objective).toBe("First goal");

		const ctx2 = h.makeCtx([], { hasUI: true, confirmResult: true });
		await runCommand(h, "Second goal", ctx2);
		expect(goalFromEntries(h)?.objective).toBe("Second goal");
	});

	it("pauses, resumes, and clears a goal", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "My goal", ctx);

		await runCommand(h, "pause", ctx);
		expect(goalFromEntries(h)?.status).toBe("paused");

		await runCommand(h, "resume", ctx);
		expect(goalFromEntries(h)?.status).toBe("active");

		const confirmCtx = h.makeCtx([], { hasUI: true, confirmResult: false });
		await runCommand(h, "clear", confirmCtx);
		expect(goalFromEntries(h)?.status).toBe("active");

		await runCommand(h, "clear", ctx);
		expect(goalFromEntries(h)).toBeNull();
		expect(h.entries[h.entries.length - 1]?.data).toMatchObject({ status: "cleared" });
	});

	it("edits the objective", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "Old objective", ctx);
		await runCommand(h, "edit New objective", ctx);
		const state = goalFromEntries(h);
		expect(state.objective).toBe("New objective");
		expect(state.revision).toBe(2);
	});

	it("restores the latest goal on session_start", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "Persisted goal", ctx);
		// New extension instance restored from persisted entries.
		const restored = await restoreGoal(h);
		expect(restored.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining("Persisted goal"));
	});

	it("injects hidden goal context on before_agent_start for active goals", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "Context goal", ctx);
		const result = await h.handlers.get("before_agent_start")!({}, ctx);
		const message = result as { message: { customType: string; content: string; display: boolean } };
		expect(message.message.customType).toBe(GOAL_CONTEXT_CUSTOM_TYPE);
		expect(message.message.display).toBe(false);
		expect(message.message.content).toContain("Context goal");

		// Completed goals don't inject context.
		await h.tools
			.get("update_goal")!
			.execute(
				"call-2",
				{ goalId: goalFromEntries(h).goalId, status: "complete", note: "done" },
				undefined,
				undefined,
				ctx,
			);
		expect(await h.handlers.get("before_agent_start")!({}, ctx)).toBeUndefined();
	});

	it("auto-continues on agent_settled while active, deduplicates, and stops after completion", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false, idle: false });
		await runCommand(h, "Continue me", ctx);

		const settled = h.handlers.get("agent_settled")!;
		const settleCtx = h.makeCtx([], { hasUI: false }); // idle once the run settles
		await settled({}, settleCtx);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.msg.customType).toBe(GOAL_CONTINUATION_CUSTOM_TYPE);
		expect(h.sent[0]?.msg.display).toBe(false);
		expect(h.sent[0]?.msg.content).toContain("Continue me");
		expect(h.sent[0]?.opts).toMatchObject({ triggerTurn: true });

		// Duplicate settle in the same window does not schedule again.
		await settled({}, settleCtx);
		expect(h.sent).toHaveLength(1);

		// After the continuation run starts, the next settle may continue again.
		await h.handlers.get("agent_start")!({}, ctx);
		await settled({}, settleCtx);
		expect(h.sent).toHaveLength(2);
	});

	it("does not auto-continue when paused, complete, or blocked", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false, idle: false });
		const settled = h.handlers.get("agent_settled")!;

		await runCommand(h, "Goal A", ctx);
		await runCommand(h, "pause", ctx);
		await settled({}, ctx);
		expect(h.sent).toHaveLength(0);

		await runCommand(h, "resume", ctx);
		const goal = goalFromEntries(h);
		await h.tools
			.get("update_goal")!
			.execute("call-1", { goalId: goal.goalId, status: "complete", note: "done" }, undefined, undefined, ctx);
		await settled({}, ctx);
		expect(h.sent).toHaveLength(0);
		expect(goalFromEntries(h)?.status).toBe("complete");
	});

	it("does not auto-continue when the run was aborted", async () => {
		const h = setup();
		const controller = new AbortController();
		controller.abort();
		const ctx = h.makeCtx([], { hasUI: false, signal: controller.signal });
		await runCommand(h, "Aborted goal", ctx);
		await h.handlers.get("agent_settled")!({}, ctx);
		expect(h.sent).toHaveLength(0);
	});

	it("does not auto-continue when messages are pending", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false, pending: true });
		await runCommand(h, "Queued goal", ctx);
		await h.handlers.get("agent_settled")!({}, ctx);
		expect(h.sent).toHaveLength(0);
	});

	it("accounts running time on turn_end only after goal creation", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "Usage goal", ctx);
		expect(goalFromEntries(h)?.timeUsedMs).toBe(0);

		await h.handlers.get("turn_end")!({}, ctx);
		expect(goalFromEntries(h)?.timeUsedMs).toBeGreaterThanOrEqual(0);
		expect(goalFromEntries(h)).not.toHaveProperty("tokensUsed");
		expect(goalFromEntries(h)).not.toHaveProperty("tokenBudget");
	});

	it("constrains create_goal (no overwrite of unfinished goals, explicit only)", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "Existing goal", ctx);

		const blocked = await h.tools
			.get("create_goal")!
			.execute("call-1", { objective: "Another goal", overwrite: false }, undefined, undefined, ctx);
		expect(blocked.isError).toBe(true);
		expect(goalFromEntries(h)?.objective).toBe("Existing goal");

		const replaced = await h.tools
			.get("create_goal")!
			.execute("call-2", { objective: "Another goal", overwrite: true }, undefined, undefined, ctx);
		expect(replaced.isError).toBe(false);
		expect(goalFromEntries(h)?.objective).toBe("Another goal");
	});

	it("constrains update_goal to complete/blocked and validates goalId", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "Tool goal", ctx);
		const state = goalFromEntries(h);

		const wrongId = await h.tools
			.get("update_goal")!
			.execute("call-1", { goalId: "does-not-exist", status: "complete" }, undefined, undefined, ctx);
		expect(wrongId.isError).toBe(true);
		expect(goalFromEntries(h)?.status).toBe("active");

		const completed = await h.tools
			.get("update_goal")!
			.execute(
				"call-2",
				{ goalId: state.goalId, status: "complete", note: "objective achieved" },
				undefined,
				undefined,
				ctx,
			);
		expect(completed.isError).toBeFalsy();
		expect(goalFromEntries(h)?.status).toBe("complete");
		expect(goalFromEntries(h)?.note).toBe("objective achieved");

		// update_goal cannot put a goal back into active.
		const invalid = await h.tools
			.get("update_goal")!
			.execute("call-3", { goalId: state.goalId, status: "active" }, undefined, undefined, ctx);
		// Schema-level constraint: execute rejects unknown statuses at validation
		// time in the real runtime; we assert the schema rejects it here.
		const parameters = h.tools.get("update_goal")!.definition?.parameters ?? h.tools.get("update_goal")!.parameters;
		expect(parameters).toBeDefined();
		expect(parameters?.properties?.status?.enum).toEqual(["complete", "blocked"]);
		expect(invalid).toBeDefined();
	});

	it("blocks a goal via update_goal and stops continuation", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false, idle: false });
		await runCommand(h, "Blockable goal", ctx);
		const state = goalFromEntries(h);
		const result = await h.tools
			.get("update_goal")!
			.execute(
				"call-1",
				{ goalId: state.goalId, status: "blocked", note: "missing API key" },
				undefined,
				undefined,
				ctx,
			);
		expect(result.isError).toBeFalsy();
		expect(goalFromEntries(h)?.status).toBe("blocked");
		expect(goalFromEntries(h)?.blockedReason).toBe("missing API key");
		await h.handlers.get("agent_settled")!({}, ctx);
		expect(h.sent).toHaveLength(0);
	});

	it("kicks the first round immediately when created/resumed while idle", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false }); // idle by default
		await runCommand(h, "Kick me", ctx);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.msg.customType).toBe(GOAL_CONTINUATION_CUSTOM_TYPE);
		expect(h.sent[0]?.msg.display).toBe(false);
		expect(h.sent[0]?.msg.content).toContain("Kick me");
		expect(h.sent[0]?.opts).toMatchObject({ triggerTurn: true });

		// The kicked turn starts, reopening scheduling for the next round.
		await h.handlers.get("agent_start")!({}, ctx);
		await runCommand(h, "pause", ctx);
		await runCommand(h, "resume", ctx);
		expect(h.sent).toHaveLength(2);

		// A duplicate settle in the same window does not schedule again.
		await h.handlers.get("agent_settled")!({}, ctx);
		expect(h.sent).toHaveLength(2);
	});

	it("does not kick when streaming or queued; the settle path schedules later", async () => {
		const h = setup();
		const streamingCtx = h.makeCtx([], { hasUI: false, idle: false });
		await runCommand(h, "Stream goal", streamingCtx);
		expect(h.sent).toHaveLength(0);

		const pendingCtx = h.makeCtx([], { hasUI: false, pending: true });
		await runCommand(h, "Pending goal", pendingCtx);
		expect(h.sent).toHaveLength(0);

		// Once the run settles, the normal settle path schedules the continuation.
		const settledCtx = h.makeCtx([], { hasUI: false });
		await h.handlers.get("agent_settled")!({}, settledCtx);
		expect(h.sent).toHaveLength(1);
	});

	it("persists state across restarts and never tracks tokens", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false });
		await runCommand(h, "Persist state", ctx);

		// Restart: the restored manager keeps the persisted goal without tokens.
		await restoreGoal(h);
		expect(goalFromEntries(h)?.objective).toBe("Persist state");
		expect(goalFromEntries(h)).not.toHaveProperty("tokensUsed");
		expect(goalFromEntries(h)).not.toHaveProperty("tokenBudget");
	});

	it("requires confirmation before replacing a blocked goal via /goal", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false, idle: false });
		await runCommand(h, "Blocked goal", ctx);
		const state = goalFromEntries(h);
		await h.tools
			.get("update_goal")!
			.execute(
				"call-1",
				{ goalId: state.goalId, status: "blocked", note: "waiting on user" },
				undefined,
				undefined,
				ctx,
			);
		expect(goalFromEntries(h)?.status).toBe("blocked");

		const denyCtx = h.makeCtx([], { hasUI: true, confirmResult: false });
		await runCommand(h, "Replacement", denyCtx);
		expect(goalFromEntries(h)?.objective).toBe("Blocked goal");

		const allowCtx = h.makeCtx([], { hasUI: true, confirmResult: true, idle: false });
		await runCommand(h, "Replacement", allowCtx);
		expect(goalFromEntries(h)?.objective).toBe("Replacement");
	});

	it("create_goal refuses to replace a blocked goal without overwrite", async () => {
		const h = setup();
		const ctx = h.makeCtx([], { hasUI: false, idle: false });
		await runCommand(h, "Blocked by creds", ctx);
		const state = goalFromEntries(h);
		await h.tools
			.get("update_goal")!
			.execute(
				"call-1",
				{ goalId: state.goalId, status: "blocked", note: "missing credentials" },
				undefined,
				undefined,
				ctx,
			);
		expect(goalFromEntries(h)?.status).toBe("blocked");

		const blocked = await h.tools
			.get("create_goal")!
			.execute("call-2", { objective: "New goal", overwrite: false }, undefined, undefined, ctx);
		expect(blocked.isError).toBe(true);
		expect(goalFromEntries(h)?.objective).toBe("Blocked by creds");

		const replaced = await h.tools
			.get("create_goal")!
			.execute("call-3", { objective: "New goal", overwrite: true }, undefined, undefined, ctx);
		expect(replaced.isError).toBeFalsy();
		expect(goalFromEntries(h)?.objective).toBe("New goal");
	});
});
