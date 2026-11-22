import { type Static, Type } from "typebox";
import { THINKING_LEVEL_OPTIONS } from "../../core/defaults.ts";
import { StringEnum } from "../../core/extensions/pi-ai-extension-view.ts";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionFactory,
} from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { SwarmBoardView } from "./board-view.ts";
import { createHostContextFromExtension, SwarmManager, type SwarmManagerOptions } from "./manager.ts";
import {
	renderBoardPostToolCall,
	renderBoardPostToolResult,
	renderBoardReadToolCall,
	renderBoardReadToolResult,
	renderSwarmFooterStatus,
	renderSwarmNotificationMessage,
	renderSwarmToolCall,
	renderSwarmToolResult,
	renderThemedSwarmStatus,
} from "./render.ts";
import {
	type BoardPostToolDetails,
	type BoardReadToolDetails,
	COORDINATOR_NAME,
	formatBoardPosts,
	formatCoordinatorNotification,
	formatSwarmStatus,
	formatWorkerInspect,
	SWARM_ACTIONS,
	SWARM_CONTEXT_TYPE,
	SWARM_ENTRY_TYPE,
	SWARM_NOTIFICATION_TYPE,
	SWARM_STATUS_KEY,
	SWARM_WORKSPACES,
	type SwarmLinkEntry,
	type SwarmNotificationDetails,
	type SwarmToolDetails,
} from "./types.ts";

const SwarmParams = Type.Object({
	action: StringEnum(SWARM_ACTIONS, {
		description: "What to do: status, inspect, models, add, model, kill, or title",
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Roster name of the worker for add, inspect, model, and kill (or base name when n > 1 or tasks is set). Lowercase, starts with a letter or digit, up to 24 chars of a-z, 0-9, -, _; not all, coordinator, coordinator-*, or user.",
		}),
	),
	brief: Type.Optional(
		Type.String({
			description:
				"The worker's assignment for add: what it owns and what done looks like. Posted publicly on the shared board.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model spec ('provider/modelId', model id, or display name; optional ':level' thinking suffix supported) for add and model. Omit on add to inherit your model.",
		}),
	),
	thinkingLevel: Type.Optional(
		StringEnum(THINKING_LEVEL_OPTIONS, {
			description:
				"Optional thinking level ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max') for add and model. Omit on add to inherit your thinking level; clamped to levels supported by the target model.",
		}),
	),
	fork: Type.Optional(
		Type.String({
			description:
				"Optional member name (or 'coordinator') whose conversation history the new worker forks from instead of starting fresh.",
		}),
	),
	workspace: Type.Optional(
		StringEnum(SWARM_WORKSPACES, {
			description:
				"Workspace mode for add: 'inherit' (default, shares cwd; good for readers/verifiers), 'share' (isolated git worktree on its own branch; good for parallel authors), or 'branch' (isolated local git clone).",
		}),
	),
	n: Type.Optional(
		Type.Number({
			description: "Optional number of homogeneous copies to spawn (<name>-1..<name>-<n>) for add.",
		}),
	),
	tasks: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional per-worker slice targets for add. Spawns one worker per task, or when paired with `concurrency`, runs a bounded worker pool that pulls tasks sequentially with a fresh turn budget per task.",
		}),
	),
	concurrency: Type.Optional(
		Type.Number({
			description:
				"Max concurrent worker slots when paired with `tasks` (queue/pool mode). Keeps GPU/RAM usage bounded and resets the per-wakeup turn budget for each task.",
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({
			description: "Optional per-wakeup turn limit override for spawned workers (default 25).",
		}),
	),
	symlinkPaths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Relative paths from the git repo root (e.g. ['.venv', 'node_modules']) to symlink into isolated 'share' or 'branch' worktrees.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "For inspect: max recent transcript entries to return (default 20).",
		}),
	),
	all: Type.Optional(
		Type.Boolean({
			description: "For models: list every catalog model instead of only models with configured credentials.",
		}),
	),
	title: Type.Optional(
		Type.String({
			description: "Short title for the swarm (for action 'title').",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description: "Why the model is being switched (for action 'model').",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description: "For kill: discard unlanded worktree/clone changes instead of blocking kill.",
		}),
	),
});

const BoardPostParams = Type.Object({
	message: Type.Optional(
		Type.String({
			description:
				"Public message to post on the shared swarm board. Mention @worker or @all to wake waiting/stopped members.",
		}),
	),
	messages: Type.Optional(
		Type.Array(
			Type.Object({
				to: Type.String({ description: "Target member name (without @)." }),
				message: Type.String({ description: "Tailored message for this member." }),
			}),
			{
				description: "Batch dispatch distinct messages to multiple members in a single call.",
			},
		),
	),
});

const BoardReadParams = Type.Object({
	since_seq: Type.Optional(
		Type.Number({
			description: "Return only board posts with seq > since_seq (default 0).",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of recent board posts to return (default 50).",
		}),
	),
});

export type SwarmToolInput = Static<typeof SwarmParams>;
export type BoardPostToolInput = Static<typeof BoardPostParams>;
export type BoardReadToolInput = Static<typeof BoardReadParams>;

export interface SwarmExtensionOptions extends SwarmManagerOptions {}

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

function findLatestSwarmLink(branch: readonly SessionEntry[]): SwarmLinkEntry | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "custom" && entry.customType === SWARM_ENTRY_TYPE && entry.data) {
			const data = entry.data as Partial<SwarmLinkEntry>;
			if (typeof data.swarmId === "string" && typeof data.swarmDir === "string") {
				return {
					swarmId: data.swarmId,
					swarmDir: data.swarmDir,
					title: typeof data.title === "string" ? data.title : "Swarm",
					active: data.active === true,
					updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
				};
			}
		}
	}
	return undefined;
}

function buildCoordinatorContextMessage(title: string, swarmId: string): string {
	return [
		`[Swarm Coordinator Mode Active: "${title}" (${swarmId})]`,
		"You are coordinating a multi-agent swarm on a shared message board.",
		"- Split independent work across named workers with `swarm` (`action: 'add'`). Give coding authors `workspace: 'share'` (isolated git worktree; pass `symlinkPaths` like `['.venv', 'node_modules']` if untracked deps are needed) and readers/verifiers `workspace: 'inherit'`.",
		"- When there are more tasks than safe parallel slots (e.g. heavy GPU/CPU work), pass `tasks` with `concurrency` to run a bounded worker pool: each worker pulls one task at a time with a fresh turn budget and notifies you when the pool finishes.",
		"- Every `add` brief is posted publicly on the board; workers park at zero token cost when `waiting` and wake automatically when `@mentioned`. Workers that hit `max_turns`, error, or go idle silently automatically notify you.",
		"- Use `swarm` with `action: 'inspect'` and `name` to view a worker's stop reason, last output, and recent transcript tail without guessing from disk.",
		"- Use `board_post` with `@worker`/`@all`, or `messages: [{ to, message }]` to dispatch tailored instructions to multiple workers in one call.",
		"- Board updates mentioning `@coordinator` arrive automatically as follow-up notifications; do not poll in a loop.",
		"- Land and verify a worker's branch/changes before calling `swarm` with `action: 'kill'`; killed workers cannot be revived.",
		"- When all work is verified and landed, summarize results clearly for the user.",
	].join("\n");
}

export function createSwarmExtension(options?: SwarmExtensionOptions): ExtensionFactory {
	return function swarmExtension(pi: ExtensionAPI): void {
		let currentCtx: ExtensionContext | undefined;
		let activeBoardView: SwarmBoardView | undefined;
		let lastInjectedContextKey: string | undefined;

		const useCtx = (ctx: ExtensionContext): void => {
			currentCtx = ctx;
			manager.setHostContext(createHostContextFromExtension(ctx));
		};

		const refreshStatus = (): void => {
			if (!currentCtx) return;
			const th = tryGetTheme(currentCtx);
			const snap = manager.getSnapshot();
			const statusText = th ? renderSwarmFooterStatus(snap, th) : manager.getStatusText();
			currentCtx.ui.setStatus(SWARM_STATUS_KEY, statusText);
		};

		const manager = new SwarmManager({
			...options,
			onPersistLink: (entry) => {
				pi.appendEntry<SwarmLinkEntry>(SWARM_ENTRY_TYPE, entry);
			},
			onStateChange: refreshStatus,
			onCoordinatorNotify: (posts, snapshot) => {
				pi.sendMessage<SwarmNotificationDetails>(
					{
						customType: SWARM_NOTIFICATION_TYPE,
						content: formatCoordinatorNotification(posts, snapshot),
						display: true,
						details: {
							swarmId: snapshot.id,
							title: snapshot.title,
							posts,
						},
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			},
			onCoordinatorModelSwitch: async (model) => pi.setModel(model),
			onCoordinatorThinkingLevelSwitch: (level) => pi.setThinkingLevel(level),
		});

		const openBoard = async (ctx: ExtensionContext): Promise<void> => {
			useCtx(ctx);
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				const snap = manager.getSnapshot();
				const text = snap ? formatSwarmStatus(snap) : "No active swarm.";
				if (ctx.mode === "print") {
					console.log(text);
				} else {
					ctx.ui.notify(text, "info");
				}
				return;
			}
			if (activeBoardView) return;

			await ctx.ui.custom<void>(
				(tui, themeInstance, keybindings, done) => {
					const view = new SwarmBoardView({
						tui,
						theme: themeInstance,
						keybindings,
						manager,
						onDone: () => {
							activeBoardView = undefined;
							done();
						},
					});
					activeBoardView = view;
					return view;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						maxHeight: "100%",
						anchor: "top-left",
					},
				},
			);
		};

		const showStatus = (ctx: ExtensionCommandContext): void => {
			const snap = manager.getSnapshot();
			if (!ctx.hasUI) {
				console.log(snap ? formatSwarmStatus(snap) : "No active swarm.");
				return;
			}
			const th = tryGetTheme(ctx);
			ctx.ui.notify(
				th ? renderThemedSwarmStatus(snap, th) : snap ? formatSwarmStatus(snap) : "No active swarm.",
				"info",
			);
		};

		pi.registerMessageRenderer<SwarmNotificationDetails>(SWARM_NOTIFICATION_TYPE, renderSwarmNotificationMessage);

		// =========================================================================
		// Tools
		// =========================================================================

		pi.registerTool(
			defineTool<typeof SwarmParams, SwarmToolDetails>({
				name: "swarm",
				label: "Swarm",
				description:
					"Orchestrate a parallel team of named AI workers coordinating on a shared message board. " +
					"Actions: `add` spawns one or more workers (use `workspace: 'share'` for git worktree isolation with optional `symlinkPaths` for untracked deps like `.venv`/`node_modules`, `'branch'` for a full local clone, or `'inherit'` for readers/verifiers; pass `fork` to clone conversation history; pass `n`, `tasks`, or `tasks` + `concurrency` for a queued worker pool with per-task turn budgets; pass `maxTurns` to override the 25-turn wakeup cap); " +
					"`status` lists every member, stop reason, turns, task pools, and workspace; " +
					"`inspect` shows a worker's detailed status, stop reason, last output, and recent transcript tail; " +
					"`models` lists available models (`all: true` for full catalog); " +
					"`model` switches a waiting/stopped worker (or coordinator) to another model and/or `thinkingLevel` keeping its history; " +
					"`kill` permanently removes a worker and its isolated workspace (land/merge work first); " +
					"`title` names the swarm.",
				promptSnippet: "Manage parallel swarm workers coordinating on a shared @mention message board",
				promptGuidelines: [
					"Use `swarm` for multi-part work that benefits from parallel specialized workers or independent verification on a shared message board.",
					"When there are more tasks than safe parallel slots (e.g. heavy local compute), pass `tasks` with `concurrency` so a bounded pool pulls one task per slot with a fresh turn budget.",
					"Give workers that edit files `workspace: 'share'` (pass `symlinkPaths` for gitignored deps like `.venv`/`node_modules`) and readers/verifiers `workspace: 'inherit'`. Always land/merge a worker's branch before calling `kill`.",
					"Idle workers stay parked in `waiting` at zero token cost and wake automatically when `@mentioned` via `board_post`. Workers hitting `max_turns`, erroring, or stopping silently automatically notify `@coordinator`; use `inspect` to check their recent transcript rather than polling `status`.",
				],
				parameters: SwarmParams,
				renderCall: (args, theme) => renderSwarmToolCall(args, theme),
				renderResult: (result, renderOpts, theme) => renderSwarmToolResult(result, renderOpts, theme),
				execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
					useCtx(ctx);
					const host = createHostContextFromExtension(ctx);
					try {
						switch (params.action) {
							case "title": {
								if (!params.title) throw new Error("Parameter 'title' is required for action 'title'");
								const snapshot = await manager.setTitle(COORDINATOR_NAME, params.title, host);
								return {
									content: [{ type: "text", text: `Swarm title set to "${snapshot.title}".` }],
									details: { action: "title", actor: COORDINATOR_NAME, title: snapshot.title, snapshot },
								};
							}
							case "models": {
								const list = manager.listModels(ctx.modelRegistry, params.all === true);
								return {
									content: [{ type: "text", text: list }],
									details: { action: "models", actor: COORDINATOR_NAME },
								};
							}
							case "status": {
								const snapshot = manager.getSnapshot();
								return {
									content: [
										{ type: "text", text: snapshot ? formatSwarmStatus(snapshot) : "No active swarm." },
									],
									details: { action: "status", actor: COORDINATOR_NAME, snapshot },
								};
							}
							case "inspect": {
								if (!params.name) throw new Error("Parameter 'name' is required for action 'inspect'");
								const inspected = manager.inspectWorker(params.name, params.limit);
								return {
									content: [
										{
											type: "text",
											text: formatWorkerInspect(inspected.member, inspected.transcript, inspected.pool),
										},
									],
									details: {
										action: "inspect",
										actor: COORDINATOR_NAME,
										target: inspected.member.name,
										inspect: inspected,
									},
								};
							}
							case "add": {
								if (!params.name) throw new Error("Parameter 'name' is required for action 'add'");
								if (!params.brief) throw new Error("Parameter 'brief' is required for action 'add'");
								const res = await manager.addWorkers(
									COORDINATOR_NAME,
									{
										name: params.name,
										brief: params.brief,
										model: params.model,
										thinkingLevel: params.thinkingLevel,
										fork: params.fork,
										workspace: params.workspace,
										n: params.n,
										tasks: params.tasks,
										concurrency: params.concurrency,
										maxTurns: params.maxTurns,
										symlinkPaths: params.symlinkPaths,
									},
									host,
								);
								const extras: string[] = [];
								if (res.queuedCount && res.queuedCount > 0) {
									extras.push(`${res.queuedCount} remaining tasks queued in pool`);
								}
								if (res.symlinked && res.symlinked.length > 0) {
									extras.push(`symlinked: ${res.symlinked.join(", ")}`);
								}
								const extraLine = extras.length > 0 ? ` (${extras.join("; ")})` : "";
								const warningBlock =
									res.warnings && res.warnings.length > 0
										? `\n\nWarnings:\n${res.warnings.map((w) => `- ${w}`).join("\n")}`
										: "";
								return {
									content: [
										{
											type: "text",
											text: `Spawned ${res.added.map((n) => `@${n}`).join(", ")}${extraLine} and posted assignment brief on the board.${warningBlock}\n\n${formatSwarmStatus(res.snapshot)}`,
										},
									],
									details: {
										action: "add",
										actor: COORDINATOR_NAME,
										added: res.added,
										poolId: res.poolId,
										queuedCount: res.queuedCount,
										symlinked: res.symlinked,
										warnings: res.warnings,
										snapshot: res.snapshot,
									},
								};
							}
							case "model": {
								if (!params.model && !params.thinkingLevel) {
									throw new Error("At least one of 'model' or 'thinkingLevel' is required for action 'model'");
								}
								const res = await manager.switchModel(
									COORDINATOR_NAME,
									{
										name: params.name,
										model: params.model,
										thinkingLevel: params.thinkingLevel,
										reason: params.reason,
									},
									host,
								);
								return {
									content: [
										{
											type: "text",
											text: `Switched @${res.target} to ${res.model} (thinking: ${res.thinkingLevel}).`,
										},
									],
									details: {
										action: "model",
										actor: COORDINATOR_NAME,
										target: res.target,
										model: res.model,
										thinkingLevel: res.thinkingLevel,
										snapshot: res.snapshot,
									},
								};
							}
							case "kill": {
								if (!params.name) throw new Error("Parameter 'name' is required for action 'kill'");
								const res = await manager.killWorker(
									COORDINATOR_NAME,
									{ name: params.name, force: params.force },
									host,
								);
								return {
									content: [{ type: "text", text: `Killed worker @${res.target} permanently.` }],
									details: {
										action: "kill",
										actor: COORDINATOR_NAME,
										target: res.target,
										snapshot: res.snapshot,
									},
								};
							}
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: message }],
							details: { action: params.action, actor: COORDINATOR_NAME, error: message },
							isError: true,
						};
					}
				},
			}),
		);

		pi.registerTool(
			defineTool<typeof BoardPostParams, BoardPostToolDetails>({
				name: "board_post",
				label: "Board Post",
				description:
					"Post a message (or a batch of per-recipient `messages`) to the shared swarm board. Mention `@worker` or `@all` to wake waiting/stopped workers or deliver follow-ups to working ones.",
				promptSnippet: "Post updates or batch-dispatch @mention instructions on the shared swarm board",
				parameters: BoardPostParams,
				renderCall: (args, theme) => renderBoardPostToolCall(args, theme),
				renderResult: (result, renderOpts, theme) => renderBoardPostToolResult(result, renderOpts, theme),
				execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
					useCtx(ctx);
					try {
						const host = createHostContextFromExtension(ctx);
						if (!manager.hasSwarm()) {
							await manager.ensureSwarm(host);
						}
						if (params.messages && params.messages.length > 0) {
							const { posts, woken } = manager.postBatchMessages(COORDINATOR_NAME, params.messages);
							const wokeText =
								woken.length > 0 ? ` Woke: ${woken.map((w) => `@${w}`).join(", ")}.` : " No members woken.";
							const seqs = posts.map((p) => `#${p.seq}`).join(", ");
							return {
								content: [
									{
										type: "text",
										text: `Posted ${posts.length} messages (${seqs}) to swarm board.${wokeText}`,
									},
								],
								details: { posts, post: posts[posts.length - 1], woken },
							};
						}
						if (!params.message) {
							throw new Error("Either 'message' or non-empty 'messages' is required for board_post");
						}
						const { post, woken } = manager.postMessage(COORDINATOR_NAME, params.message);
						const wokeText =
							woken.length > 0 ? ` Woke: ${woken.map((w) => `@${w}`).join(", ")}.` : " No members mentioned.";
						return {
							content: [{ type: "text", text: `Posted #${post.seq} to swarm board.${wokeText}` }],
							details: { post, woken },
						};
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: message }],
							details: { error: message },
							isError: true,
						};
					}
				},
			}),
		);

		pi.registerTool(
			defineTool<typeof BoardReadParams, BoardReadToolDetails>({
				name: "board_read",
				label: "Board Read",
				description: "Read messages from the shared swarm message board.",
				promptSnippet: "Read recent or historical posts from the shared swarm board",
				parameters: BoardReadParams,
				renderCall: (args, theme) => renderBoardReadToolCall(args, theme),
				renderResult: (result, renderOpts, theme) => renderBoardReadToolResult(result, renderOpts, theme),
				execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
					useCtx(ctx);
					const { posts, totalPosts } = manager.readBoard(params.since_seq ?? 0, params.limit ?? 50);
					return {
						content: [{ type: "text", text: formatBoardPosts(posts) }],
						details: { posts, totalPosts },
					};
				},
			}),
		);

		// =========================================================================
		// Command & Shortcut
		// =========================================================================

		pi.registerShortcut("alt+s", {
			description: "Open interactive swarm board",
			handler: async (ctx) => {
				await openBoard(ctx);
			},
		});

		pi.registerCommand("swarm", {
			description:
				"Orchestrate a multi-agent swarm: /swarm <task>, /swarm board (Alt+S), /swarm status, /swarm inspect <name>, /swarm stop, /swarm kill <name>, /swarm end",
			getArgumentCompletions: (prefix) => {
				const trimmed = prefix.trimStart();
				const parts = trimmed.split(/\s+/);
				if (parts.length <= 1 && !prefix.endsWith(" ")) {
					const subcommands = ["board", "status", "inspect", "stop", "kill", "end", "title"];
					const matches = subcommands.filter((cmd) => cmd.startsWith(trimmed.toLowerCase()));
					return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
				}
				const sub = parts[0]?.toLowerCase();
				if (sub === "kill" || sub === "inspect") {
					const namePrefix = prefix.endsWith(" ") ? "" : (parts[1] ?? "");
					const snap = manager.getSnapshot();
					if (!snap) return null;
					const workers = snap.members.filter(
						(m) =>
							(sub === "inspect" || (m.role === "worker" && m.state !== "killed")) &&
							m.name.startsWith(namePrefix),
					);
					return workers.length > 0
						? workers.map((m) => ({
								value: `${sub} ${m.name}`,
								label: `@${m.name} (${m.state})`,
							}))
						: null;
				}
				return null;
			},
			handler: async (args, ctx) => {
				useCtx(ctx);
				const trimmed = args.trim();
				if (!trimmed) {
					await openBoard(ctx);
					return;
				}

				const parts = trimmed.split(/\s+/);
				const sub = parts[0]!.toLowerCase();

				try {
					switch (sub) {
						case "board": {
							await openBoard(ctx);
							return;
						}
						case "status": {
							showStatus(ctx);
							return;
						}
						case "inspect": {
							const target = parts[1];
							if (!target) {
								ctx.ui.notify("Usage: /swarm inspect <worker> [limit]", "warning");
								return;
							}
							const limit = parts[2] ? Number.parseInt(parts[2], 10) : undefined;
							const inspected = manager.inspectWorker(target, Number.isFinite(limit) ? limit : undefined);
							ctx.ui.notify(formatWorkerInspect(inspected.member, inspected.transcript, inspected.pool), "info");
							return;
						}
						case "stop": {
							const stopped = manager.stopAllWorkers();
							ctx.ui.notify(
								stopped > 0
									? `Stopped ${stopped} running swarm worker${stopped === 1 ? "" : "s"}.`
									: "No running swarm workers.",
								"info",
							);
							return;
						}
						case "end": {
							manager.endCoordinatorMode();
							lastInjectedContextKey = undefined;
							ctx.ui.notify("Exited swarm coordinator mode.", "info");
							return;
						}
						case "title": {
							const title = trimmed.slice(parts[0]!.length).trim();
							if (!title) {
								ctx.ui.notify("Usage: /swarm title <name>", "warning");
								return;
							}
							const snap = await manager.setTitle(COORDINATOR_NAME, title, createHostContextFromExtension(ctx));
							ctx.ui.notify(`Swarm title set to "${snap.title}".`, "info");
							return;
						}
						case "kill": {
							const target = parts[1];
							if (!target) {
								ctx.ui.notify("Usage: /swarm kill <worker> [--force]", "warning");
								return;
							}
							const force = parts.includes("--force") || parts.includes("-f");
							const res = await manager.killWorker(
								COORDINATOR_NAME,
								{ name: target, force },
								createHostContextFromExtension(ctx),
							);
							ctx.ui.notify(`Killed swarm worker @${res.target}.`, "info");
							return;
						}
						default: {
							// Start or activate swarm coordinator mode with the user's task.
							const shortTitle = trimmed.length > 56 ? `${trimmed.slice(0, 53)}...` : trimmed;
							await manager.ensureSwarm(createHostContextFromExtension(ctx), shortTitle);
							refreshStatus();
							pi.sendUserMessage(
								`Start a swarm to accomplish the following goal. Act as the coordinator: break the work into clear parallel worker assignments with \`swarm\` (\`action: "add"\`, using \`workspace: "share"\` for concurrent editors and \`workspace: "inherit"\` for readers/verifiers), coordinate on the shared board, verify and land changes, and summarize the result.\n\nGoal:\n${trimmed}`,
								ctx.isIdle() ? undefined : { deliverAs: "followUp" },
							);
						}
					}
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				}
			},
		});

		// =========================================================================
		// Lifecycle Events
		// =========================================================================

		const restoreForBranch = (ctx: ExtensionContext): void => {
			useCtx(ctx);
			lastInjectedContextKey = undefined;
			const link = findLatestSwarmLink(ctx.sessionManager.getBranch());
			if (link) {
				manager.restoreFromLink(link, createHostContextFromExtension(ctx));
			}
			refreshStatus();
		};

		pi.on("session_start", async (_event, ctx) => {
			restoreForBranch(ctx);
		});

		pi.on("session_tree", async (_event, ctx) => {
			if (activeBoardView) {
				activeBoardView.dispose();
				activeBoardView = undefined;
			}
			restoreForBranch(ctx);
		});

		pi.on("before_agent_start", async (_event, ctx) => {
			useCtx(ctx);
			const snap = manager.getSnapshot();
			if (!snap || !snap.active) {
				lastInjectedContextKey = undefined;
				return;
			}
			const key = `${snap.id}:${snap.title}`;
			if (lastInjectedContextKey === key) return;
			lastInjectedContextKey = key;
			// Hidden custom message injected once per swarm/title change so KV-cache prefix stays intact.
			return {
				message: {
					customType: SWARM_CONTEXT_TYPE,
					content: buildCoordinatorContextMessage(snap.title, snap.id),
					display: false,
				},
			};
		});

		pi.on("model_select", async (_event, ctx) => {
			useCtx(ctx);
			refreshStatus();
		});

		pi.on("thinking_level_select", async (_event, ctx) => {
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
			if (activeBoardView) {
				activeBoardView.dispose();
				activeBoardView = undefined;
			}
			await manager.dispose();
			currentCtx?.ui.setStatus(SWARM_STATUS_KEY, undefined);
		});
	};
}

export default createSwarmExtension();
