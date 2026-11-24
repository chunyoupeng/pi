/**
 * Goal extension (built-in).
 *
 * A Codex-style persistent goal: define an objective with `/goal <objective>`,
 * then the agent keeps working toward it across rounds via `agent_before_settle`
 * until marked complete/blocked, paused, aborted, or auto-paused for idle loops.
 *
 * - Command: `/goal` (show), `/goal <objective>` / `/goal set <objective>` (create),
 *   `/goal pause|resume|clear`, `/goal edit [<objective>]`.
 * - Single tool: `goal` with `action: "get" | "create" | "complete" | "blocked"`.
 * - Hidden goal context is injected on `before_agent_start` once per goal state
 *   change (and re-injected after compaction/reload).
 * - Continuation happens in `agent_before_settle` so aborts, errors, queued
 *   messages, RPC/print-mode settlement, and notifications all stay accurate.
 */

import { type Static, Type } from "typebox";
import { StringEnum } from "../../core/extensions/pi-ai-extension-view.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { defineTool } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { GoalManager, type GoalStartResult, type GoalUI } from "./manager.ts";
import {
	compactText,
	formatGoalFooterStatus,
	formatGoalSummary,
	renderGoalContinuationMessage,
	renderGoalFooterStatus,
	renderGoalSummary,
	renderGoalToolCall,
	renderGoalToolResult,
} from "./render.ts";
import {
	GOAL_ACTIONS,
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTINUATION_CUSTOM_TYPE,
	GOAL_CUSTOM_TYPE,
	GOAL_STATUS_KEY,
	type GoalClearedMarker,
	type GoalContinuationDetails,
	type GoalState,
	type GoalToolDetails,
	isGoalUnfinished,
	MAX_GOAL_OBJECTIVE_CHARS,
	parseGoalCommand,
} from "./state.ts";

const GoalParams = Type.Object({
	action: StringEnum(GOAL_ACTIONS, {
		description:
			'Action to perform: "get" reads the current goal; "create" starts a new goal (ONLY when the user explicitly asks); "complete" marks the active goal achieved and verified; "blocked" stops auto-continuation when unable to proceed.',
	}),
	objective: Type.Optional(
		Type.String({
			minLength: 1,
			description: `Goal objective text (required for action "create", max ${MAX_GOAL_OBJECTIVE_CHARS} chars).`,
		}),
	),
	overwrite: Type.Optional(
		Type.Boolean({
			description: 'For action "create": set true to replace an existing unfinished goal.',
		}),
	),
	goalId: Type.Optional(
		Type.String({
			description: 'Current goal id (required for action "complete" and "blocked").',
		}),
	),
	note: Type.Optional(
		Type.String({
			description: 'Optional completion summary (for "complete") or blocking reason (for "blocked").',
		}),
	),
});

type GoalParamsInput = Static<typeof GoalParams>;

function commandUiFrom(ctx: ExtensionCommandContext): GoalUI {
	const hasUI = ctx.hasUI;
	return {
		hasUI,
		requestConfirm: (title, message) => (hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(true)),
		abort: () => ctx.abort(),
		waitForIdle: () => ctx.waitForIdle(),
		isStreaming: () => !ctx.isIdle(),
	};
}

function toolUiFrom(ctx: ExtensionContext): GoalUI {
	return {
		hasUI: false,
		// Tool calls never prompt interactively or abort the active run.
		requestConfirm: () => Promise.resolve(true),
		isStreaming: () => !ctx.isIdle(),
	};
}

/** Access `ctx.ui.theme` when initialized; non-TUI contexts leave the global theme proxy unset. */
function tryGetTheme(ctx: ExtensionContext): Theme | undefined {
	if (!ctx.hasUI) return undefined;
	try {
		const th = ctx.ui.theme;
		void th.fg;
		return th;
	} catch {
		return undefined;
	}
}

function goalContextKey(state: GoalState | null): string | undefined {
	return state && (state.status === "active" || state.status === "paused")
		? `${state.goalId}:${state.revision}:${state.status}`
		: undefined;
}

export default function goalExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined;
	const useCtx = (ctx: ExtensionContext): void => {
		currentCtx = ctx;
	};

	const refreshStatus = (): void => {
		if (!currentCtx) return;
		const state = manager.getState();
		const elapsed = manager.elapsedTimeMs();
		const th = tryGetTheme(currentCtx);
		const statusText = th ? renderGoalFooterStatus(state, elapsed, th) : formatGoalFooterStatus(state, elapsed);
		currentCtx.ui.setStatus(GOAL_STATUS_KEY, statusText);
	};

	const manager = new GoalManager({
		persist: (entry) => {
			pi.appendEntry<GoalState | GoalClearedMarker>(GOAL_CUSTOM_TYPE, entry);
		},
		notify: (message, type) => {
			if (currentCtx) {
				currentCtx.ui.notify(message, type);
			} else {
				console.log(message);
			}
		},
		sendContinuation: (content, details) => {
			pi.sendMessage<GoalContinuationDetails>(
				{
					customType: GOAL_CONTINUATION_CUSTOM_TYPE,
					content,
					display: true,
					details,
				},
				{ triggerTurn: true },
			);
		},
		onStateChange: refreshStatus,
	});

	// Track the last goal state (goalId:revision:status) already injected into
	// conversation context so we never spam duplicate hidden context messages and
	// never invalidate KV prefix caches. Reset on session start, tree navigation,
	// and compaction.
	let lastInjectedGoalKey: string | undefined;

	const kickIfIdle = (ctx: ExtensionContext): GoalStartResult => {
		return manager.startIfIdle({
			signalAborted: () => ctx.signal?.aborted === true,
			idle: () => ctx.isIdle(),
			hasPendingMessages: () => ctx.hasPendingMessages(),
		});
	};

	const kickAndAwaitIfNonInteractive = async (ctx: ExtensionCommandContext): Promise<void> => {
		const started = kickIfIdle(ctx);
		if (started === "continued" && (ctx.mode === "print" || ctx.mode === "json")) {
			await ctx.waitForIdle();
		}
	};

	// =========================================================================
	// Transcript renderer
	// =========================================================================

	pi.registerMessageRenderer<GoalContinuationDetails>(GOAL_CONTINUATION_CUSTOM_TYPE, renderGoalContinuationMessage);

	// =========================================================================
	// Unified Tool
	// =========================================================================

	pi.registerTool(
		defineTool<typeof GoalParams, GoalToolDetails>({
			name: "goal",
			label: "Goal",
			description:
				'Read or manage the persistent autonomous goal. Use action="get" to inspect the current goal; action="create" ONLY when the user explicitly asks to start a new goal (refuses to replace an unfinished goal unless overwrite=true); action="complete" when the objective is fully achieved and verified; action="blocked" when unable to proceed.',
			promptSnippet: "Read or update the persistent autonomous goal (get, create, complete, blocked)",
			parameters: GoalParams,
			execute: async (_toolCallId, params: GoalParamsInput, _signal, _onUpdate, ctx) => {
				useCtx(ctx);
				switch (params.action) {
					case "get": {
						const state = manager.getState();
						return {
							content: [{ type: "text", text: state ? JSON.stringify(state, null, 2) : "null" }],
							details: { action: "get", goal: state },
						};
					}
					case "create": {
						if (!params.objective || !params.objective.trim()) {
							const error = 'Parameter "objective" is required for action "create".';
							return {
								content: [{ type: "text", text: error }],
								details: { action: "create", error },
								isError: true,
							};
						}
						const existing = manager.getState();
						if (existing && isGoalUnfinished(existing.status) && !params.overwrite) {
							const error = `Cannot create a goal: goal "${existing.objective}" (${existing.status}) is still unfinished. Ask the user for confirmation or pass overwrite=true to replace it.`;
							return {
								content: [{ type: "text", text: error }],
								details: { action: "create", goal: existing, error },
								isError: true,
							};
						}
						const outcome = await manager.create(params.objective, toolUiFrom(ctx));
						if (outcome.status === "created") {
							return {
								content: [
									{
										type: "text",
										text: `Goal created (id ${outcome.state.goalId}): ${outcome.state.objective}`,
									},
								],
								details: { action: "create", goal: outcome.state },
							};
						}
						const error = outcome.status === "error" ? outcome.error : "Goal creation cancelled.";
						return {
							content: [{ type: "text", text: error }],
							details: { action: "create", error },
							isError: true,
						};
					}
					case "complete":
					case "blocked": {
						const current = manager.getState();
						if (!current) {
							const error = 'No goal is set. Use action="create" only when the user explicitly asks for one.';
							return {
								content: [{ type: "text", text: error }],
								details: { action: params.action, error },
								isError: true,
							};
						}
						if (!params.goalId) {
							const error = `Parameter "goalId" is required for action "${params.action}". Current goal is ${current.goalId}.`;
							return {
								content: [{ type: "text", text: error }],
								details: { action: params.action, goal: current, error },
								isError: true,
							};
						}
						if (current.goalId !== params.goalId) {
							const error = `goalId mismatch: the current goal is ${current.goalId}, not ${params.goalId}. Call goal(action="get") first.`;
							return {
								content: [{ type: "text", text: error }],
								details: { action: params.action, goal: current, error },
								isError: true,
							};
						}
						const outcome =
							params.action === "complete" ? manager.complete(params.note) : manager.block(params.note);
						if (outcome.status === "error") {
							return {
								content: [{ type: "text", text: outcome.error }],
								details: { action: params.action, goal: current, error: outcome.error },
								isError: true,
							};
						}
						if (outcome.status === "unchanged") {
							return {
								content: [{ type: "text", text: `${outcome.message} No change.` }],
								details: { action: params.action, goal: outcome.state, unchanged: true },
							};
						}
						const updated = outcome.status === "changed" ? outcome.state : manager.getState();
						const noteSuffix = params.note?.trim() ? ` (${params.note.trim()})` : "";
						return {
							content: [
								{
									type: "text",
									text: `Goal marked ${params.action}${noteSuffix}. Auto-continuation stopped.`,
								},
							],
							details: { action: params.action, goal: updated },
						};
					}
				}
			},
			renderCall: renderGoalToolCall,
			renderResult: renderGoalToolResult,
		}),
	);

	// =========================================================================
	// Command
	// =========================================================================

	pi.registerCommand("goal", {
		description:
			"Show or manage the persistent goal: /goal <objective> creates one; pause, resume, clear, edit, set, and show manage it.",
		getArgumentCompletions: (prefix) => {
			const options = ["pause", "resume", "clear", "edit", "set", "show", "status"];
			const filtered = options.filter((option) => option.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			useCtx(ctx);
			const parsed = parseGoalCommand(args);

			switch (parsed.kind) {
				case "show": {
					const state = manager.getState();
					const elapsed = manager.elapsedTimeMs();
					if (ctx.mode === "print") {
						console.log(formatGoalSummary(state, elapsed));
					} else {
						const th = tryGetTheme(ctx);
						ctx.ui.notify(th ? renderGoalSummary(state, elapsed, th) : formatGoalSummary(state, elapsed), "info");
					}
					refreshStatus();
					return;
				}
				case "pause": {
					manager.pause(commandUiFrom(ctx));
					refreshStatus();
					return;
				}
				case "resume": {
					const outcome = manager.resume();
					refreshStatus();
					if (outcome.status === "resumed") {
						await kickAndAwaitIfNonInteractive(ctx);
					} else if (outcome.status === "unchanged" && outcome.state.status === "active") {
						if (ctx.isIdle() && !ctx.hasPendingMessages()) {
							ctx.ui.notify("Resuming active goal.", "info");
							await kickAndAwaitIfNonInteractive(ctx);
						} else {
							ctx.ui.notify("Goal is already active.", "info");
						}
					}
					return;
				}
				case "clear": {
					await manager.clear(commandUiFrom(ctx));
					lastInjectedGoalKey = undefined;
					refreshStatus();
					return;
				}
				case "edit": {
					let nextObjective = parsed.objective;
					if (nextObjective === null) {
						const state = manager.getState();
						if (!state) {
							ctx.ui.notify("No goal to edit. Create one with /goal <objective>.", "warning");
							return;
						}
						if (state.status === "complete") {
							ctx.ui.notify(
								"Cannot edit a completed goal. Create a new goal with /goal <objective>.",
								"warning",
							);
							return;
						}
						if (!ctx.hasUI) {
							ctx.ui.notify("Usage: /goal edit <objective>", "warning");
							return;
						}
						const edited = await ctx.ui.editor("Edit goal objective", state.objective);
						if (edited === undefined) {
							ctx.ui.notify("Goal edit cancelled.", "info");
							return;
						}
						nextObjective = edited;
					}
					manager.edit(nextObjective);
					refreshStatus();
					return;
				}
				case "create": {
					const outcome = await manager.create(parsed.objective, commandUiFrom(ctx));
					refreshStatus();
					if (outcome.status === "created") {
						lastInjectedGoalKey = undefined;
						await kickAndAwaitIfNonInteractive(ctx);
					}
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
		lastInjectedGoalKey = undefined;
		refreshStatus();
	});

	// Tree navigation changes the active branch without recreating the extension
	// instance. Reload goal state from the new branch, but never auto-start LLM
	// work just from browsing history; let the user run `/goal resume` or send a message.
	pi.on("session_tree", async (_event, ctx) => {
		useCtx(ctx);
		manager.restore(ctx.sessionManager.getBranch());
		lastInjectedGoalKey = undefined;
		refreshStatus();
		const restored = manager.getState();
		if (restored?.status === "active") {
			ctx.ui.notify(
				`Restored active goal "${compactText(restored.objective, 48)}". Run /goal resume to continue or /goal pause.`,
				"info",
			);
		}
	});

	// Compaction summarizes earlier custom messages out of active context, so
	// force re-injection of the full objective and goalId on the next round.
	pi.on("session_compact", async (_event, ctx) => {
		useCtx(ctx);
		lastInjectedGoalKey = undefined;
	});

	pi.on("session_shutdown", async () => {
		manager.shutdown();
		currentCtx = undefined;
		lastInjectedGoalKey = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		useCtx(ctx);
		if (event?.messageType === "user") {
			manager.onUserPrompt();
		}
		const state = manager.getState();
		const key = goalContextKey(state);
		if (!key) {
			lastInjectedGoalKey = undefined;
			return;
		}
		// Start continuations already carry the full objective and ID in the
		// trigger message; record the key so we do not add a duplicate context block.
		if (event?.messageType === "custom" && event.message?.customType === GOAL_CONTINUATION_CUSTOM_TYPE) {
			lastInjectedGoalKey = key;
			return;
		}
		if (lastInjectedGoalKey === key) return;
		const content = manager.buildContextContent();
		if (!content) return;
		lastInjectedGoalKey = key;
		return { message: { customType: GOAL_CONTEXT_CUSTOM_TYPE, content, display: false } };
	});

	pi.on("agent_start", async (_event, ctx) => {
		useCtx(ctx);
		manager.onAgentStart();
		refreshStatus();
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		useCtx(ctx);
		manager.onToolExecutionStart(event.toolName);
	});

	pi.on("turn_end", async (_event, ctx) => {
		useCtx(ctx);
		manager.onTurnEnd();
	});

	pi.on("agent_end", async (_event, ctx) => {
		useCtx(ctx);
		manager.onAgentEnd();
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		useCtx(ctx);
		const state = manager.getState();
		const key = goalContextKey(state);
		const decision = manager.onBeforeSettle({
			outcome: event.outcome,
			hasPendingMessages: event.context.pendingMessages.length > 0 || ctx.hasPendingMessages(),
			alreadyContinuing: event.continue,
			includeObjective: key !== undefined && lastInjectedGoalKey !== key,
		});
		if (!decision.continue) return;

		lastInjectedGoalKey = key;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: GOAL_CONTINUATION_CUSTOM_TYPE,
					content: decision.content,
					display: true,
					details: decision.details,
				},
			],
			continue: true,
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		useCtx(ctx);
		refreshStatus();
	});
}
