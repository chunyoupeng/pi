import { type Static, Type } from "typebox";
import { StringEnum } from "../../core/extensions/pi-ai-extension-view.ts";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionFactory,
} from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { type BgProcessSpawner, BgTaskManager, buildTaskShellEnv } from "./manager.ts";
import {
	renderBgFooterStatus,
	renderBgNotificationMessage,
	renderBgToolCall,
	renderBgToolResult,
	renderThemedSingleTask,
	renderThemedTaskList,
} from "./render.ts";
import {
	BG_NOTIFY_MODES,
	BG_TASK_ACTIONS,
	BG_TASK_ENTRY_TYPE,
	BG_TASK_NOTIFICATION_TYPE,
	BG_TASK_STATUS_KEY,
	type BgNotificationDetails,
	type BgTaskSnapshot,
	type BgTaskToolDetails,
	DEFAULT_LEASE_SECONDS,
	formatNotificationMessage,
	formatSingleTaskReport,
	formatTaskListReport,
	isActiveTaskStatus,
} from "./types.ts";

const BgTaskParams = Type.Object({
	action: StringEnum(BG_TASK_ACTIONS, {
		description: "Action to perform: start, status, list, extend, send_input, kill, clear",
	}),
	id: Type.Optional(
		Type.String({
			description: "Task ID (e.g. bg-1). Required for extend, send_input, kill; optional for status.",
		}),
	),
	command: Type.Optional(
		Type.String({
			description:
				"Shell command to run in the background (for start). Omit only when creating a pure scheduled reminder with label + delay_seconds/interval_seconds.",
		}),
	),
	label: Type.Optional(
		Type.String({
			description: "Short human-readable description or scheduled reminder note (for start).",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for command execution (defaults to current session working directory).",
		}),
	),
	lease_seconds: Type.Optional(
		Type.Number({
			description: `Soft timeout lease in seconds (default ${DEFAULT_LEASE_SECONDS}). On start, sets initial lease before waking you to inspect progress; on extend, grants additional seconds from now without killing the running process.`,
		}),
	),
	delay_seconds: Type.Optional(
		Type.Number({
			description:
				"Optional delay in seconds before the first run (0 runs immediately; when omitted with interval_seconds, waits one interval before the first run).",
		}),
	),
	interval_seconds: Type.Optional(
		Type.Number({
			description:
				"Optional recurring interval in seconds. Schedules the next run after each run finishes (never overlaps).",
		}),
	),
	notify_on: Type.Optional(
		StringEnum(BG_NOTIFY_MODES, {
			description:
				'When run completions trigger a notification turn: "all" (default), "failure" (only non-zero exit), or "success" (only zero exit). Lease expirations and timeouts always notify.',
		}),
	),
	input: Type.Optional(
		Type.String({
			description: "Text to write to task stdin (for send_input, include trailing newline if needed).",
		}),
	),
	close_stdin: Type.Optional(
		Type.Boolean({
			description: "Close task stdin after writing input (for send_input).",
		}),
	),
});

export type BgTaskToolInput = Static<typeof BgTaskParams>;

export interface BgTaskExtensionOptions {
	spawner?: BgProcessSpawner;
	graceSeconds?: number;
	debounceMs?: number;
	now?: () => number;
}

/** Access `ctx.ui.theme` when initialized; non-TUI test contexts leave the global theme proxy unset. */
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

function showTaskListCommand(ctx: ExtensionCommandContext, tasks: readonly BgTaskSnapshot[]): void {
	if (!ctx.hasUI) {
		console.log(formatTaskListReport(tasks));
		return;
	}
	const th = tryGetTheme(ctx);
	ctx.ui.notify(th ? renderThemedTaskList(tasks, th) : formatTaskListReport(tasks), "info");
}

function showSingleTaskCommand(ctx: ExtensionCommandContext, task: BgTaskSnapshot): void {
	if (!ctx.hasUI) {
		console.log(formatSingleTaskReport(task));
		return;
	}
	const th = tryGetTheme(ctx);
	ctx.ui.notify(th ? renderThemedSingleTask(task, th) : formatSingleTaskReport(task), "info");
}

export function createBgTaskExtension(options?: BgTaskExtensionOptions): ExtensionFactory {
	return function bgTaskExtension(pi: ExtensionAPI): void {
		let currentCtx: ExtensionContext | undefined;
		const useCtx = (ctx: ExtensionContext): void => {
			currentCtx = ctx;
		};

		let manager: BgTaskManager;
		const refreshStatus = (): void => {
			if (!currentCtx) return;
			const th = tryGetTheme(currentCtx);
			const statusText = th ? renderBgFooterStatus(manager.list(), th) : manager.getStatusText();
			currentCtx.ui.setStatus(BG_TASK_STATUS_KEY, statusText);
		};

		manager = new BgTaskManager({
			spawner: options?.spawner,
			graceSeconds: options?.graceSeconds,
			debounceMs: options?.debounceMs,
			now: options?.now,
			onPersist: (snapshot: BgTaskSnapshot) => {
				pi.appendEntry<BgTaskSnapshot>(BG_TASK_ENTRY_TYPE, snapshot);
			},
			onStateChange: refreshStatus,
			onNotify: (events) => {
				pi.sendMessage<BgNotificationDetails>(
					{
						customType: BG_TASK_NOTIFICATION_TYPE,
						content: formatNotificationMessage(events),
						display: true,
						details: { events },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			},
		});

		pi.registerMessageRenderer<BgNotificationDetails>(BG_TASK_NOTIFICATION_TYPE, renderBgNotificationMessage);

		pi.registerTool(
			defineTool<typeof BgTaskParams, BgTaskToolDetails>({
				name: "bg_task",
				label: "Background Task",
				description:
					"Start and manage long-running background commands or delayed/recurring scheduled tasks. Tasks run with a soft timeout lease (default 300s): when the lease expires, the process stays alive while you receive a check-in notification with recent output so you can extend the lease, send stdin, or kill it.",
				promptSnippet: "Run long or scheduled tasks in the background with soft-lease timeout check-ins",
				promptGuidelines: [
					"Use `bg_task` for long-running commands, background watchers, or delayed/recurring scheduled tasks instead of blocking the foreground turn; notifications are pushed automatically when a task finishes or its soft lease expires, so do not poll in a loop.",
					"Adjust `lease_seconds` on `bg_task` based on expected task duration (default 300s). When a `lease_expired` notification arrives, inspect the recent output and call `bg_task` with `action='extend'` if the task is still making progress, `action='send_input'` if awaiting stdin, or `action='kill'` if stuck.",
				],
				parameters: BgTaskParams,
				renderCall: (args, theme) => renderBgToolCall(args, theme),
				renderResult: (result, renderOpts, theme) => renderBgToolResult(result, renderOpts, theme),
				execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
					useCtx(ctx);
					try {
						switch (params.action) {
							case "start": {
								const env = buildTaskShellEnv({
									sessionId: ctx.sessionManager.getSessionId(),
									sessionFile: ctx.sessionManager.getSessionFile(),
									provider: ctx.model?.provider,
									modelId: ctx.model?.id,
									thinkingLevel: ctx.thinkingLevel,
								});
								const task = await manager.start({
									command: params.command,
									label: params.label,
									cwd: params.cwd ?? ctx.cwd,
									env,
									leaseSeconds: params.lease_seconds,
									delaySeconds: params.delay_seconds,
									intervalSeconds: params.interval_seconds,
									notifyOn: params.notify_on,
								});
								return {
									content: [{ type: "text", text: formatSingleTaskReport(task) }],
									details: { action: "start", task },
								};
							}
							case "status": {
								if (!params.id) {
									const tasks = manager.list();
									return {
										content: [{ type: "text", text: formatTaskListReport(tasks) }],
										details: { action: "status", tasks },
									};
								}
								const task = manager.get(params.id);
								if (!task) {
									throw new Error(`Background task '${params.id}' not found`);
								}
								return {
									content: [{ type: "text", text: formatSingleTaskReport(task) }],
									details: { action: "status", task },
								};
							}
							case "list": {
								const tasks = manager.list();
								return {
									content: [{ type: "text", text: formatTaskListReport(tasks) }],
									details: { action: "list", tasks },
								};
							}
							case "extend": {
								if (!params.id) {
									throw new Error("Parameter 'id' is required for action 'extend'");
								}
								const task = manager.extend(params.id, params.lease_seconds);
								return {
									content: [
										{
											type: "text",
											text: `Extended lease for [${task.id}] (${task.leaseSeconds}s):\n\n${formatSingleTaskReport(task)}`,
										},
									],
									details: { action: "extend", task },
								};
							}
							case "send_input": {
								if (!params.id) {
									throw new Error("Parameter 'id' is required for action 'send_input'");
								}
								if (params.input === undefined && !params.close_stdin) {
									throw new Error(
										"Parameter 'input' (or close_stdin=true) is required for action 'send_input'",
									);
								}
								const task = manager.sendInput(params.id, params.input ?? "", params.close_stdin);
								return {
									content: [
										{
											type: "text",
											text: `Sent stdin to [${task.id}]${params.close_stdin ? " and closed stdin" : ""}.\n\n${formatSingleTaskReport(task)}`,
										},
									],
									details: { action: "send_input", task },
								};
							}
							case "kill": {
								if (!params.id) {
									throw new Error("Parameter 'id' is required for action 'kill'");
								}
								const task = await manager.kill(params.id);
								return {
									content: [
										{
											type: "text",
											text: `Stopped background task [${task.id}].\n\n${formatSingleTaskReport(task)}`,
										},
									],
									details: { action: "kill", task },
								};
							}
							case "clear": {
								const clearedCount = manager.clearFinished();
								return {
									content: [
										{
											type: "text",
											text: `Cleared ${clearedCount} finished background task${clearedCount === 1 ? "" : "s"}.`,
										},
									],
									details: { action: "clear", clearedCount },
								};
							}
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: message }],
							details: { action: params.action, error: message },
							isError: true,
						};
					}
				},
			}),
		);

		pi.registerCommand("bg", {
			description:
				"View and manage background tasks: /bg [list], /bg status <id>, /bg extend <id> [seconds], /bg kill <id>, /bg clear",
			getArgumentCompletions: (prefix) => {
				const trimmed = prefix.trimStart();
				const parts = trimmed.split(/\s+/);
				if (parts.length <= 1 && !prefix.endsWith(" ")) {
					const subcommands = ["list", "status", "extend", "kill", "clear"];
					const matches = subcommands.filter((cmd) => cmd.startsWith(trimmed.toLowerCase()));
					return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
				}
				const sub = parts[0]?.toLowerCase();
				if (sub === "status" || sub === "extend" || sub === "kill") {
					const idPrefix = prefix.endsWith(" ") ? "" : (parts[1] ?? "");
					if (parts.length <= 2) {
						const tasks = manager
							.list()
							.filter((task) => sub === "status" || isActiveTaskStatus(task.status))
							.filter((task) => task.id.startsWith(idPrefix));
						return tasks.length > 0
							? tasks.map((task) => ({
									value: `${sub} ${task.id}`,
									label: `${task.id} (${task.status}) - ${task.label}`,
								}))
							: null;
					}
				}
				return null;
			},
			handler: async (args, ctx) => {
				useCtx(ctx);
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const sub = parts[0]?.toLowerCase() ?? "list";

				try {
					switch (sub) {
						case "list": {
							showTaskListCommand(ctx, manager.list());
							return;
						}
						case "status": {
							const id = parts[1];
							if (!id) {
								showTaskListCommand(ctx, manager.list());
								return;
							}
							const task = manager.get(id);
							if (!task) {
								ctx.ui.notify(`Background task '${id}' not found`, "warning");
								return;
							}
							showSingleTaskCommand(ctx, task);
							return;
						}
						case "extend": {
							const id = parts[1];
							if (!id) {
								ctx.ui.notify("Usage: /bg extend <id> [seconds]", "warning");
								return;
							}
							const extra = parts[2] !== undefined ? Number(parts[2]) : undefined;
							const task = manager.extend(id, extra);
							const th = tryGetTheme(ctx);
							if (th) {
								ctx.ui.notify(
									`\x1b[22;39m${th.fg("success", `● Extended [${task.id}]`)} ${th.fg("text", `lease by ${task.leaseSeconds}s`)}`,
									"info",
								);
							} else {
								ctx.ui.notify(`Extended [${task.id}] lease by ${task.leaseSeconds}s`, "info");
							}
							return;
						}
						case "kill": {
							const id = parts[1];
							if (!id) {
								ctx.ui.notify("Usage: /bg kill <id>", "warning");
								return;
							}
							const task = await manager.kill(id);
							ctx.ui.notify(`Stopped [${task.id}] (${task.status})`, "info");
							return;
						}
						case "clear": {
							const count = manager.clearFinished();
							ctx.ui.notify(`Cleared ${count} finished background task${count === 1 ? "" : "s"}`, "info");
							return;
						}
						default: {
							const byId = manager.get(sub);
							if (byId) {
								showSingleTaskCommand(ctx, byId);
								return;
							}
							ctx.ui.notify(
								"Usage: /bg [list], /bg status <id>, /bg extend <id> [seconds], /bg kill <id>, /bg clear",
								"warning",
							);
						}
					}
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				}
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			useCtx(ctx);
			refreshStatus();
		});

		pi.on("turn_end", async (_event, ctx) => {
			useCtx(ctx);
			refreshStatus();
		});

		pi.on("agent_settled", async (_event, ctx) => {
			useCtx(ctx);
			refreshStatus();
		});

		pi.on("session_shutdown", async () => {
			await manager.dispose();
			currentCtx?.ui.setStatus(BG_TASK_STATUS_KEY, undefined);
		});
	};
}

export default createBgTaskExtension();
