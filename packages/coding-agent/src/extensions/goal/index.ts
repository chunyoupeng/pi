/**
 * Goal extension (built-in).
 *
 * A Codex-style persistent goal: define an objective with `/goal <objective>`,
 * then the agent keeps working toward it across turns. State is persisted as
 * session custom entries and restored from the current branch on reload.
 *
 * - Commands: `/goal` (show), `/goal <objective>` (create/replace),
 *   `/goal pause|resume|clear`, `/goal edit [<objective>]`.
 * - Tools: `get_goal`, `create_goal` (explicit requests only), `update_goal`
 *   (complete/blocked only).
 * - Hidden goal context is injected each round via `before_agent_start`.
 * - Auto-continuation happens on `agent_settled` while the goal is active,
 *   idle, no queued messages, no abort, and no error; commands that activate a
 *   goal (`/goal <objective>`, `/goal resume`) start the first round
 *   immediately when the agent is idle via `startIfIdle`.
 * - `turn_end` accrues running time toward the goal, including the turn that
 *   marks the goal complete/blocked.
 *
 * The goal deliberately does NOT enforce token or resource budgets; it only
 * tracks wall-clock time used.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { defineTool } from "../../core/extensions/types.ts";
import { GoalManager, type GoalUI, lastAssistantMessageHasError } from "./manager.ts";
import {
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTINUATION_CUSTOM_TYPE,
	GOAL_CUSTOM_TYPE,
	GOAL_STATUS_KEY,
	type GoalState,
	isGoalUnfinished,
	parseGoalEditArgs,
} from "./state.ts";

function uiFrom(ctx: ExtensionContext): GoalUI {
	const hasUI = ctx.hasUI;
	return {
		hasUI,
		requestConfirm: (title, message) => (hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(true)),
		abort: () => ctx.abort(),
		isStreaming: () => !ctx.isIdle(),
	};
}

function showGoalText(ctx: ExtensionCommandContext, text: string): void {
	if (ctx.mode === "print") {
		// Direct output for one-shot print mode; ui.notify is a no-op there.
		console.log(text);
	} else {
		ctx.ui.notify(text, "info");
	}
}

export default function goalExtension(pi: ExtensionAPI): void {
	// Track the most recent ctx so manager callbacks (notify/status) can reach the UI.
	let currentCtx: ExtensionContext | undefined;
	const useCtx = (ctx: ExtensionContext): void => {
		currentCtx = ctx;
	};
	// Declared before the manager: passed as onStateChange below.
	const refreshStatus = (): void => {
		if (!currentCtx) return;
		currentCtx.ui.setStatus(GOAL_STATUS_KEY, manager.getStatusText());
	};

	// Shared mutable state reconstructed from session entries on load.
	const manager = new GoalManager({
		persist: (entry) => {
			pi.appendEntry<GoalState | { status: "cleared"; clearedAt: number; goalId?: string }>(GOAL_CUSTOM_TYPE, entry);
		},
		notify: (message, type) => {
			if (currentCtx) {
				currentCtx.ui.notify(message, type);
			} else {
				// Fallback for print mode before any ctx is available.
				console.log(message);
			}
		},
		sendContinuation: (content, details) => {
			pi.sendMessage(
				{
					customType: GOAL_CONTINUATION_CUSTOM_TYPE,
					content,
					display: false,
					details,
				},
				{ triggerTurn: true },
			);
		},
		onStateChange: refreshStatus,
	});

	//
	// Start the first round right away when the goal is active and the agent is
	// idle with nothing queued. When streaming/queued, skip and let the
	// agent_settled handler schedule the continuation after the run settles.
	//
	const kickIfIdle = (ctx: ExtensionContext): void => {
		manager.startIfIdle({
			signalAborted: () => ctx.signal?.aborted === true,
			idle: () => ctx.isIdle(),
			hasPendingMessages: () => ctx.hasPendingMessages(),
		});
	};

	// =========================================================================
	// Tools
	// =========================================================================

	pi.registerTool(
		defineTool({
			name: "get_goal",
			label: "Get goal",
			description: "Get the current goal (objective, status, time used). Returns null when no goal is set.",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				useCtx(ctx);
				const state = manager.getState();
				return {
					content: [
						{
							type: "text",
							text: state ? JSON.stringify(state, null, 2) : "null",
						},
					],
					details: state ? { goalId: state.goalId, status: state.status } : {},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "create_goal",
			label: "Create goal",
			description:
				'Create a new persistent goal the agent will keep working toward. ONLY use this tool when the user explicitly asked you to start a new goal (e.g. "set a goal", "my goal is..."). Returns an error if an incomplete goal already exists unless overwrite=true.',
			parameters: Type.Object({
				objective: Type.String({ minLength: 1, description: "The goal objective (user-provided text)." }),
				overwrite: Type.Optional(
					Type.Boolean({
						description: "Set true to replace an existing incomplete goal without asking.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				useCtx(ctx);
				const existing = manager.getState();
				const unfinished = existing !== null && isGoalUnfinished(existing.status);
				if (unfinished && !params.overwrite) {
					return {
						content: [
							{
								type: "text",
								text: `Cannot create a goal: goal "${existing!.objective}" (${existing!.status}) is still unfinished. Ask the user for confirmation or pass overwrite=true to replace it.`,
							},
						],
						details: {},
						isError: true,
					};
				}
				const result = await manager.create(params.objective, {
					...uiFrom(ctx),
					// Tools are constrained: never prompt interactively, never abort the run.
					requestConfirm: () => Promise.resolve(true),
					abort: () => {},
				});
				const state = manager.getState();
				return {
					content: [
						{
							type: "text",
							text:
								result === "created" && state
									? `Goal created (id ${state.goalId}): ${state.objective}`
									: "Goal creation cancelled.",
						},
					],
					details: state ? { goalId: state.goalId, status: state.status } : {},
					isError: result !== "created",
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "update_goal",
			label: "Update goal",
			description:
				'Update the current goal. Only two transitions are allowed: "complete" when the objective is fully achieved and verified, and "blocked" when you cannot proceed (missing credentials, external dependency, safety boundary, waiting on the user). Completing or blocking stops auto-continuation.',
			parameters: Type.Object({
				goalId: Type.String({ description: "The goal id returned by get_goal." }),
				status: StringEnum(["complete", "blocked"] as const, {
					description: '"complete" only when the objective is done; "blocked" only when you cannot proceed.',
				}),
				note: Type.Optional(Type.String({ description: "Optional short note explaining completion/block." })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				useCtx(ctx);
				const state = manager.getState();
				if (!state) {
					return {
						content: [
							{ type: "text", text: "No goal is set. Use create_goal when the user explicitly asks for one." },
						],
						details: {},
						isError: true,
					};
				}
				if (state.goalId !== params.goalId) {
					return {
						content: [
							{
								type: "text",
								text: `goalId mismatch: the current goal is ${state.goalId}, not ${params.goalId}. Call get_goal first.`,
							},
						],
						details: {},
						isError: true,
					};
				}
				const ui = { ...uiFrom(ctx), abort: () => {}, isStreaming: () => false };
				const result =
					params.status === "complete" ? manager.complete(params.note, ui) : manager.block(params.note, ui);
				const updated = manager.getState();
				return {
					content: [
						{
							type: "text",
							text:
								result === "noop"
									? `Goal is already ${state.status}; no change.`
									: `Goal marked ${params.status}${params.note ? ` (${params.note})` : ""}. Auto-continuation stopped.`,
						},
					],
					details: updated ? { goalId: updated.goalId, status: updated.status } : {},
				};
			},
		}),
	);

	// =========================================================================
	// Command
	// =========================================================================

	pi.registerCommand("goal", {
		description:
			"Show or manage the persistent goal: /goal <objective> creates one; pause, resume, clear, and edit manage it.",
		getArgumentCompletions: (prefix) => {
			const options = ["pause", "resume", "clear", "edit", "show"];
			const filtered = options.filter((option) => option.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			useCtx(ctx);
			const trimmed = args.trim();
			const command = trimmed.split(/\s+/)[0]?.toLowerCase();

			if (!trimmed || command === "show" || command === "status") {
				showGoalText(ctx, manager.formatSummary());
				refreshStatus();
				return;
			}

			const ui = uiFrom(ctx);

			switch (command) {
				case "pause": {
					manager.pause(ui);
					refreshStatus();
					return;
				}
				case "resume": {
					manager.resume(ui);
					refreshStatus();
					// Kick the first round immediately when idle (settle handles it otherwise).
					kickIfIdle(ctx);
					return;
				}
				case "clear": {
					await manager.clear(ui);
					refreshStatus();
					return;
				}
				case "edit": {
					const objective = parseGoalEditArgs(trimmed.slice("edit".length));
					if (objective === null) {
						ctx.ui.notify("Usage: /goal edit <objective>", "warning");
						return;
					}
					manager.edit(objective, ui);
					refreshStatus();
					return;
				}
				default: {
					const created = await manager.create(trimmed, ui);
					refreshStatus();
					// Kick the first round immediately when idle, but only when the goal
					// was actually created (a cancelled replacement keeps the old goal
					// and should not trigger a fresh continuation).
					if (created === "created") kickIfIdle(ctx);
					return;
				}
			}
		},
	});

	// =========================================================================
	// Lifecycle events
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		useCtx(ctx);
		manager.restore(ctx.sessionManager.getBranch());
		refreshStatus();
	});

	// Tree navigation changes the active branch without recreating the extension
	// instance. Reload goal state from the new branch so an old branch's goal is
	// never injected into, or continued on, the selected branch.
	pi.on("session_tree", async (_event, ctx) => {
		useCtx(ctx);
		manager.restore(ctx.sessionManager.getBranch());
		refreshStatus();
		// Tree navigation is only available while idle. If the selected branch
		// contains an active goal, resume its work immediately.
		kickIfIdle(ctx);
	});

	// Hidden goal messages are persisted by the generic custom-message path so
	// they can trigger a turn. Keep only the newest one in provider context;
	// otherwise every automatic continuation would duplicate the objective and
	// consume an unbounded amount of context.
	pi.on("context", async (event) => {
		const hiddenTypes = new Set([GOAL_CONTEXT_CUSTOM_TYPE, GOAL_CONTINUATION_CUSTOM_TYPE]);
		let newestHiddenIndex = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message?.role === "custom" && hiddenTypes.has(message.customType)) {
				newestHiddenIndex = i;
				break;
			}
		}
		if (newestHiddenIndex < 0) return;
		return {
			messages: event.messages.filter((message, index) => {
				return message.role !== "custom" || !hiddenTypes.has(message.customType) || index === newestHiddenIndex;
			}),
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		useCtx(ctx);
		const content = manager.buildContextContent();
		if (!content) return;
		// Hidden user-role custom message: objective is user data, never part of
		// the system prompt. display:false keeps it out of the transcript.
		return { message: { customType: GOAL_CONTEXT_CUSTOM_TYPE, content, display: false } };
	});

	pi.on("agent_start", async (_event, ctx) => {
		useCtx(ctx);
		manager.onAgentStart();
	});

	pi.on("turn_end", async (_event, ctx) => {
		useCtx(ctx);
		manager.onTurnEnd();
		refreshStatus();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		useCtx(ctx);
		await manager.onAgentSettled({
			signalAborted: () => ctx.signal?.aborted === true,
			idle: () => ctx.isIdle(),
			hasPendingMessages: () => ctx.hasPendingMessages(),
			lastAssistantHasError: () => lastAssistantMessageHasError(ctx.sessionManager.getBranch()),
		});
		refreshStatus();
	});
}
