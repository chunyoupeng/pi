import { type Api, type AssistantMessage, getCurrentSystemMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { StringEnum } from "../../core/extensions/pi-ai-extension-view.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import {
	buildDreamPrompt,
	collectDreamDiagnostics,
	DEFAULT_DREAM_IDLE_MS,
	DEFAULT_DREAM_JITTER_MS,
	type DreamTriggerKind,
	MEMORY_DREAM_CUSTOM_TYPE,
	type MemoryDreamMessageDetails,
} from "./dream.ts";
import {
	MemoryListComponent,
	renderDreamMessage,
	renderPromptSection,
	renderToolCall,
	renderToolResult,
} from "./render.ts";
import { MemoryStore, parseLinks, resolveProjectRoot, scoreEntry } from "./store.ts";
import {
	GLOBAL_CHAR_BUDGET,
	type MemoryCategory,
	type MemoryEntry,
	type MemoryLinks,
	type MemoryQueryScope,
	type MemoryScope,
	type MemoryToolDetails,
	PROJECT_CHAR_BUDGET,
} from "./types.ts";

export interface MemoryExtensionOptions {
	idleDreamMs?: number;
	jitterMs?: number;
	enableIdleDream?: boolean;
}

const CATEGORIES: readonly MemoryCategory[] = ["fact", "decision", "convention", "gotcha"] as const;
const ACTIONS = ["add", "update", "delete", "get", "search", "list"] as const;
const SCOPES = ["project", "global", "all"] as const;
const MEMORY_UPDATE_CUSTOM_TYPE = "memory-update";

const MemoryParams = Type.Object({
	action: StringEnum(ACTIONS, {
		description: "Action to perform: add, update, delete, get, search, list",
	}),
	scope: Type.Optional(
		StringEnum(SCOPES, {
			description:
				"Memory scope: 'project' (current repo, default for add/update/delete), 'global' (cross-project user preferences/invariants), or 'all' (default for list/search; omitted on get checks project then global)",
		}),
	),
	id: Type.Optional(
		Type.String({
			description:
				"Entry ID: a short lowercase kebab-case slug naming the fact, e.g. npm-check-skips-tests. Choose it on add (derived from the title if omitted); required for update, delete, get",
		}),
	),
	title: Type.Optional(Type.String({ description: "One-line summary title (required for add)" })),
	body: Type.Optional(
		Type.String({ description: "Detailed description, rationale, or context. Link related entries as [[id]]" }),
	),
	category: Type.Optional(
		StringEnum(CATEGORIES, {
			description:
				"Category: fact (general truth), decision (architecture/choice), convention (standards/commands), gotcha (pitfalls)",
		}),
	),
	pinned: Type.Optional(
		Type.Boolean({
			description: "Whether to include the full body in the prompt index; other entries show only their title",
		}),
	),
	query: Type.Optional(Type.String({ description: "Search query string (for search action)" })),
});

function getSessionId(ctx: ExtensionContext): string | undefined {
	const id = ctx.sessionManager?.getSessionId?.();
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

function getLeafId(ctx: ExtensionContext): string | undefined {
	const id = ctx.sessionManager?.getLeafId?.();
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

function formatModelName(model: Model<Api> | undefined): string {
	if (!model) return "none";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function formatDurationMs(ms: number): string {
	const clamped = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(clamped / 3600);
	const minutes = Math.floor((clamped % 3600) / 60);
	const seconds = clamped % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function resolveWriteScope(scope: MemoryQueryScope | undefined, action: string): MemoryScope {
	if (scope === "all") {
		throw new Error(`Scope 'all' is not supported for action '${action}'; use 'project' or 'global'`);
	}
	return scope ?? "project";
}

function formatLinkIds(entry: MemoryEntry): string {
	const ids = parseLinks(entry.body);
	return ids.length ? ` -> ${ids.map((id) => `[[${id}]]`).join(", ")}` : "";
}

function formatEntryRef(entry: MemoryEntry): string {
	return `${entry.scope === "global" ? "[global] " : ""}[${entry.id}]`;
}

// Linked entries come with their bodies so one `get` covers the neighborhood; linkers stay titles only.
function formatLinks(links: MemoryLinks): string {
	let text = "";
	if (links.linked.length) {
		const linked = links.linked.map(
			(e) => `${formatEntryRef(e)} (${e.category}) ${e.title}${e.body ? `\n${e.body}` : ""}`,
		);
		text += `\n\nLinked entries:\n\n${linked.join("\n\n")}`;
	}
	if (links.missing.length) {
		text += `\n\nMissing links: ${links.missing.map((id) => `[[${id}]]`).join(", ")}`;
	}
	if (links.linkedFrom.length) {
		text += `\n\nLinked from:\n${links.linkedFrom.map((e) => `- ${formatEntryRef(e)} (${e.category}) ${e.title}`).join("\n")}`;
	}
	return text;
}

function rankCombinedSearch(query: string, entries: readonly MemoryEntry[]): MemoryEntry[] {
	const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
	if (terms.length === 0) return [];
	const scored = entries
		.map((entry) => {
			const base = scoreEntry(entry, terms);
			return { entry, score: entry.archived ? base * 0.5 : base };
		})
		.filter(({ score }) => score > 0);
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		const aArchived = Boolean(a.entry.archived);
		const bArchived = Boolean(b.entry.archived);
		if (aArchived !== bArchived) return aArchived ? 1 : -1;
		return b.entry.updated.localeCompare(a.entry.updated);
	});
	return scored.map(({ entry }) => entry);
}

export function createMemoryExtension(options: MemoryExtensionOptions = {}): (pi: ExtensionAPI) => void {
	const idleDreamMs = options.idleDreamMs ?? DEFAULT_DREAM_IDLE_MS;
	const jitterMs = options.jitterMs ?? DEFAULT_DREAM_JITTER_MS;
	const enableIdleDream = options.enableIdleDream ?? true;

	return function memoryExtensionImpl(pi: ExtensionAPI): void {
		let store: MemoryStore | null = null;
		let globalStore: MemoryStore | null = null;
		const rootByCwd = new Map<string, string>();
		let frozenSection: string | null = null;
		let reuseTranscriptSection = false;

		// Per-session idle dreaming scheduler state.
		let dirtyTurnsSinceDream = 0;
		let lastDreamedLeafId: string | undefined;
		let dreamTurnActive = false;
		let dreamDispatching = false;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		let idleFireAtMs: number | null = null;

		const ensureStore = async (cwd: string): Promise<MemoryStore> => {
			let root = rootByCwd.get(cwd);
			if (root === undefined) {
				root = await resolveProjectRoot(cwd);
				rootByCwd.set(cwd, root);
			}
			const candidate = new MemoryStore(root);
			if (!store || store.projectRoot !== root || store.memoryDir !== candidate.memoryDir) {
				store = candidate;
			}
			return store;
		};

		const ensureGlobalStore = (): MemoryStore => {
			const candidate = MemoryStore.global();
			if (!globalStore || globalStore.memoryDir !== candidate.memoryDir) {
				globalStore = candidate;
			}
			return globalStore;
		};

		const cancelIdleTimer = (): void => {
			if (idleTimer !== null) {
				clearTimeout(idleTimer);
				idleTimer = null;
				idleFireAtMs = null;
			}
		};

		const computeIdleDelayMs = (): number => {
			const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
			return Math.max(0, idleDreamMs + jitter);
		};

		const scheduleIdleDream = (ctx: ExtensionContext): void => {
			cancelIdleTimer();
			if (!enableIdleDream || dirtyTurnsSinceDream <= 0 || !ctx.model) {
				return;
			}
			const delayMs = computeIdleDelayMs();
			idleFireAtMs = Date.now() + delayMs;
			const timer = setTimeout(() => {
				if (idleTimer !== timer) return;
				idleTimer = null;
				idleFireAtMs = null;
				void triggerDream(ctx, "idle");
			}, delayMs);
			timer.unref?.();
			idleTimer = timer;
		};

		const triggerDream = async (ctx: ExtensionContext, trigger: DreamTriggerKind): Promise<boolean> => {
			if (dreamDispatching || !ctx.model) return false;
			if (trigger === "idle") {
				if (!enableIdleDream || dirtyTurnsSinceDream <= 0 || dreamTurnActive) {
					return false;
				}
				if (ctx.isIdle?.() === false || Boolean(ctx.hasPendingMessages?.())) {
					return false;
				}
				const currentLeafId = getLeafId(ctx);
				if (currentLeafId !== undefined && currentLeafId === lastDreamedLeafId) {
					dirtyTurnsSinceDream = 0;
					return false;
				}
			}

			dreamDispatching = true;
			try {
				const projectStore = await ensureStore(ctx.cwd);
				const gStore = ensureGlobalStore();

				const [projectEntries, globalEntries] = await Promise.all([
					projectStore.listEntries(),
					gStore.listEntries(),
				]);
				const projectDecay = await projectStore.runDecay({ companionEntries: globalEntries });
				const globalDecay = await gStore.runDecay({ companionEntries: projectEntries });
				const diagnostics = await collectDreamDiagnostics(projectStore, gStore);

				if (trigger === "idle") {
					if (ctx.isIdle?.() === false || Boolean(ctx.hasPendingMessages?.())) {
						return false;
					}
				}

				const content = buildDreamPrompt({
					projectRoot: projectStore.projectRoot,
					trigger,
					diagnostics,
					decayedProjectIds: projectDecay.archivedIds,
					decayedGlobalIds: globalDecay.archivedIds,
				});
				const details: MemoryDreamMessageDetails = {
					trigger,
					projectRoot: projectStore.projectRoot,
					decayedCount: projectDecay.archivedIds.length + globalDecay.archivedIds.length,
					brokenLinkCount: diagnostics.brokenLinks.length,
				};

				dreamTurnActive = true;
				const deliverAs = trigger === "manual" && ctx.isIdle?.() === false ? "followUp" : undefined;
				pi.sendMessage<MemoryDreamMessageDetails>(
					{
						customType: MEMORY_DREAM_CUSTOM_TYPE,
						content,
						display: true,
						details,
					},
					deliverAs ? { triggerTurn: true, deliverAs } : { triggerTurn: true },
				);
				return true;
			} catch (err) {
				dreamTurnActive = false;
				if (trigger === "manual") {
					throw err;
				}
				return false;
			} finally {
				dreamDispatching = false;
			}
		};

		pi.registerMessageRenderer<MemoryDreamMessageDetails>(MEMORY_DREAM_CUSTOM_TYPE, renderDreamMessage);

		// The current session's <project_memory> is frozen, so tell the agent about user edits directly.
		const notifyAgent = (change: string): void => {
			pi.sendMessage({
				customType: MEMORY_UPDATE_CUSTOM_TYPE,
				display: false,
				content: `[Project memory changed by the user: ${change}. This supersedes <project_memory> until it is refreshed.]`,
			});
		};

		// A reload or fork continues a warm prompt cache, so it keeps the section the transcript
		// already has. Startup and resume usually come after the cache expired, so they re-render.
		pi.on("session_start", async (event, ctx) => {
			frozenSection = null;
			reuseTranscriptSection = event.reason === "reload" || event.reason === "fork";
			if (!reuseTranscriptSection) {
				cancelIdleTimer();
				dirtyTurnsSinceDream = 0;
				dreamTurnActive = false;
				lastDreamedLeafId = undefined;
				const projectStore = await ensureStore(ctx.cwd);
				const gStore = ensureGlobalStore();
				const sessionId = getSessionId(ctx);
				if (sessionId) {
					await projectStore.recordSessionActivity(sessionId);
					await gStore.recordSessionActivity(sessionId);
				}
				const [projectEntries, globalEntries] = await Promise.all([
					projectStore.listEntries(),
					gStore.listEntries(),
				]);
				await projectStore.runDecay({ companionEntries: globalEntries });
				await gStore.runDecay({ companionEntries: projectEntries });
			}
		});

		pi.on("session_before_compact", async () => {
			cancelIdleTimer();
		});

		// Compaction already rewrites the conversation, and the tool results that recorded this
		// session's memory writes may now be summarized away.
		pi.on("session_compact", async () => {
			frozenSection = null;
			reuseTranscriptSection = false;
		});

		pi.on("input", async () => {
			cancelIdleTimer();
		});

		pi.on("turn_start", async () => {
			cancelIdleTimer();
		});

		pi.on("session_tree", async () => {
			cancelIdleTimer();
			dreamTurnActive = false;
		});

		pi.on("session_shutdown", async () => {
			cancelIdleTimer();
			dreamTurnActive = false;
		});

		// Track dirty turns and arm the idle dream countdown after a clean assistant stop.
		pi.on("agent_end", async (event, ctx) => {
			const lastAssistant = [...event.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			const isDreamTurn =
				dreamTurnActive ||
				event.messages.some(
					(message) => message.role === "custom" && message.customType === MEMORY_DREAM_CUSTOM_TYPE,
				);
			if (isDreamTurn) {
				dreamTurnActive = false;
				if (lastAssistant?.stopReason === "stop") {
					dirtyTurnsSinceDream = 0;
					const currentLeafId = getLeafId(ctx);
					if (currentLeafId !== undefined) {
						lastDreamedLeafId = currentLeafId;
					}
				}
				return;
			}

			if (lastAssistant?.stopReason !== "stop") return;

			const currentLeafId = getLeafId(ctx);
			if (currentLeafId !== undefined && currentLeafId === lastDreamedLeafId) {
				return;
			}
			dirtyTurnsSinceDream += 1;
			scheduleIdleDream(ctx);
		});

		// Freeze <project_memory> between refresh points so mid-session memory writes never mutate
		// the system prompt prefix or invalidate the KV cache.
		pi.on("before_agent_start", async (event, ctx) => {
			cancelIdleTimer();
			if (frozenSection === null) {
				const existingTag = reuseTranscriptSection
					? getCurrentSystemMessage(ctx.sessionManager.buildSessionProjection().messages)?.sections?.project_memory
					: undefined;
				if (typeof existingTag === "string") {
					frozenSection = existingTag.replace(/^<project_memory>\n?/u, "").replace(/\n?<\/project_memory>$/u, "");
				} else {
					const currentStore = await ensureStore(ctx.cwd);
					const currentGlobalStore = ensureGlobalStore();
					const [projectEntries, globalEntries] = await Promise.all([
						currentStore.listEntries(),
						currentGlobalStore.listEntries(),
					]);
					frozenSection = renderPromptSection(
						currentStore.projectRoot,
						projectEntries,
						PROJECT_CHAR_BUDGET,
						globalEntries,
						GLOBAL_CHAR_BUDGET,
					);
				}
			}
			event.systemPromptOptions.sections.project_memory = frozenSection;
		});

		pi.registerTool({
			name: "memory",
			label: "Project Memory",
			description:
				"Read and write persistent project and cross-project global memory. Proactively record verified gotchas, non-obvious commands, architectural decisions, and user preferences across sessions without waiting to be asked.",
			promptSnippet: "Read and write persistent project and global memory",
			promptGuidelines: [
				"PROACTIVE MEMORY: Memory exists to predict what future sessions will need so you do not rediscover pitfalls or re-ask settled questions. Call `memory` (`add` or `update`) in the same turn without waiting to be asked whenever you verify:",
				"1. User preferences or corrections (workflow rules, style bans, tool choices) — record them as you apply the fix.",
				"2. Non-obvious build, test, lint, or runtime commands learned through scripts or trial and error.",
				"3. Verified root-cause gotchas, environment traps, or subtle failure modes.",
				"4. Settled architectural decisions, module boundaries, or repository conventions.",
				"Scope discipline: use `scope='project'` (default) for repository-specific facts, commands, and architecture; use `scope='global'` ONLY for durable cross-repository user preferences and universal engineering invariants.",
				"Do not store unverified guesses, mid-task progress, transient TODOs, facts obvious from reading the code, or secrets/credentials.",
				"Check `<project_memory>` before adding: prefer `update` over creating a near-duplicate. Keep `title` to one scannable line, put detail in `body`, and reserve `pinned=true` for high-impact redlines.",
				"Name entries with descriptive kebab-case IDs (e.g. `npm-check-skips-tests`) and link related notes—including across project and global scopes—as `[[other-id]]`; `get` returns linked entries one hop away and automatically restores archived notes.",
			],
			parameters: MemoryParams,

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const projectStore = await ensureStore(ctx.cwd);
				const gStore = ensureGlobalStore();

				switch (params.action) {
					case "add": {
						const targetScope = resolveWriteScope(params.scope, "add");
						if (!params.title) {
							throw new Error("Parameter 'title' is required for action 'add'");
						}
						const targetStore = targetScope === "global" ? gStore : projectStore;
						const entry = await targetStore.addEntry({
							id: params.id,
							title: params.title,
							body: params.body,
							category: params.category,
							pinned: params.pinned,
						});
						const scopeLabel = targetScope === "global" ? "global" : "project";
						return {
							content: [
								{
									type: "text",
									text: `Recorded ${scopeLabel} memory [${entry.id}] (${entry.category}): "${entry.title}"${entry.body ? `\n\n${entry.body}` : ""}`,
								},
							],
							details: { action: "add", scope: targetScope, entry } as MemoryToolDetails,
						};
					}
					case "update": {
						const targetScope = resolveWriteScope(params.scope, "update");
						if (!params.id) {
							throw new Error("Parameter 'id' is required for action 'update'");
						}
						const targetStore = targetScope === "global" ? gStore : projectStore;
						const entry = await targetStore.updateEntry(params.id, {
							title: params.title,
							body: params.body,
							category: params.category,
							pinned: params.pinned,
						});
						const scopeLabel = targetScope === "global" ? "global" : "project";
						return {
							content: [
								{
									type: "text",
									text: `Updated ${scopeLabel} memory [${entry.id}] (${entry.category}): "${entry.title}"`,
								},
							],
							details: { action: "update", scope: targetScope, entry } as MemoryToolDetails,
						};
					}
					case "delete": {
						const targetScope = resolveWriteScope(params.scope, "delete");
						if (!params.id) {
							throw new Error("Parameter 'id' is required for action 'delete'");
						}
						const targetStore = targetScope === "global" ? gStore : projectStore;
						const companionStore = targetScope === "global" ? projectStore : gStore;
						const entry = await targetStore.deleteEntry(params.id);
						const companionEntries = await companionStore.listEntries();
						const { linkedFrom } = await targetStore.findLinks(entry, companionEntries);
						const dangling = linkedFrom.length
							? `\n\nStill linked from ${linkedFrom.map((e) => formatEntryRef(e)).join(", ")}; update their bodies.`
							: "";
						const scopeLabel = targetScope === "global" ? "global" : "project";
						return {
							content: [
								{
									type: "text",
									text: `Deleted ${scopeLabel} memory [${entry.id}]: "${entry.title}"${dangling}`,
								},
							],
							details: {
								action: "delete",
								scope: targetScope,
								deletedId: params.id,
								entry,
							} as MemoryToolDetails,
						};
					}
					case "get": {
						if (!params.id) {
							throw new Error("Parameter 'id' is required for action 'get'");
						}
						const requestedScope: MemoryQueryScope | undefined = params.scope;
						let targetStore: MemoryStore;
						let companionStore: MemoryStore;
						let entry: MemoryEntry | null = null;

						if (requestedScope === "global") {
							targetStore = gStore;
							companionStore = projectStore;
							entry = await gStore.getEntry(params.id, { includeArchived: true });
						} else if (requestedScope === "project") {
							targetStore = projectStore;
							companionStore = gStore;
							entry = await projectStore.getEntry(params.id, { includeArchived: true });
						} else {
							entry = await projectStore.getEntry(params.id, { includeArchived: true });
							if (entry) {
								targetStore = projectStore;
								companionStore = gStore;
							} else {
								entry = await gStore.getEntry(params.id, { includeArchived: true });
								targetStore = gStore;
								companionStore = projectStore;
							}
						}

						if (!entry) {
							return {
								content: [{ type: "text", text: `Memory entry [${params.id}] not found.` }],
								details: { action: "get", scope: requestedScope, error: "Not found" } as MemoryToolDetails,
							};
						}

						let restoredFromArchive = false;
						if (entry.archived) {
							entry = await targetStore.restoreEntry(entry.id);
							restoredFromArchive = true;
						}

						const companionEntries = await companionStore.listEntries();
						const links = await targetStore.findLinks(entry, companionEntries);

						const sessionId = getSessionId(ctx);
						const targetHitIds: string[] = [entry.id];
						const companionHitIds: string[] = [];
						for (const linked of links.linked) {
							const linkedScope = linked.scope ?? targetStore.scope;
							if (linkedScope === targetStore.scope) {
								targetHitIds.push(linked.id);
							} else {
								companionHitIds.push(linked.id);
							}
						}
						await targetStore.ledger.recordHits(targetHitIds, sessionId);
						if (companionHitIds.length > 0) {
							await companionStore.ledger.recordHits(companionHitIds, sessionId);
						}

						const scopePrefix = entry.scope === "global" ? "[global] " : "";
						const restoredNote = restoredFromArchive ? " (restored from archive)" : "";
						return {
							content: [
								{
									type: "text",
									text: `Memory ${scopePrefix}[${entry.id}] (${entry.category}${entry.pinned ? ", pinned" : ""})${restoredNote}\nTitle: ${entry.title}\nUpdated: ${entry.updated}${entry.body ? `\n\n${entry.body}` : ""}${formatLinks(links)}`,
								},
							],
							details: { action: "get", scope: entry.scope, entry, links } as MemoryToolDetails,
						};
					}
					case "search": {
						if (!params.query) {
							throw new Error("Parameter 'query' is required for action 'search'");
						}
						const queryScope: MemoryQueryScope = params.scope ?? "all";
						const combined = queryScope === "all";
						let results: MemoryEntry[];
						let globalResults: MemoryEntry[] | undefined;

						if (queryScope === "project") {
							results = await projectStore.searchEntries(params.query, { includeArchived: true });
						} else if (queryScope === "global") {
							results = await gStore.searchEntries(params.query, { includeArchived: true });
							globalResults = results;
						} else {
							const [projMatches, globMatches] = await Promise.all([
								projectStore.searchEntries(params.query, { includeArchived: true }),
								gStore.searchEntries(params.query, { includeArchived: true }),
							]);
							globalResults = globMatches;
							results = rankCombinedSearch(params.query, [...globMatches, ...projMatches]);
						}

						const archivedCount = results.filter((e) => e.archived).length;
						const summary = results.length
							? results
									.map((e) => {
										const scopePrefix = combined && e.scope === "global" ? "[global] " : "";
										const archivedPrefix = e.archived ? "[archived] " : "";
										return `- ${scopePrefix}${archivedPrefix}[${e.id}] (${e.category}) ${e.title}${formatLinkIds(e)}`;
									})
									.join("\n")
							: "No matching memory entries found.";
						return {
							content: [{ type: "text", text: summary }],
							details: {
								action: "search",
								scope: queryScope,
								entries: results,
								...(globalResults !== undefined ? { globalEntries: globalResults } : {}),
								...(archivedCount > 0 ? { archivedCount } : {}),
							} as MemoryToolDetails,
						};
					}
					case "list": {
						const queryScope: MemoryQueryScope = params.scope ?? "all";
						const combined = queryScope === "all";
						let all: MemoryEntry[];
						let globalList: MemoryEntry[] | undefined;
						let archivedCount = 0;

						if (queryScope === "project") {
							const [projActive, projArchived] = await Promise.all([
								projectStore.listEntries(),
								projectStore.listArchivedEntries(),
							]);
							all = projActive;
							archivedCount = projArchived.length;
						} else if (queryScope === "global") {
							const [globActive, globArchived] = await Promise.all([
								gStore.listEntries(),
								gStore.listArchivedEntries(),
							]);
							all = globActive;
							globalList = globActive;
							archivedCount = globArchived.length;
						} else {
							const [globActive, projActive, globArchived, projArchived] = await Promise.all([
								gStore.listEntries(),
								projectStore.listEntries(),
								gStore.listArchivedEntries(),
								projectStore.listArchivedEntries(),
							]);
							globalList = globActive;
							all = [...globActive, ...projActive];
							archivedCount = globArchived.length + projArchived.length;
						}

						const archivedNote =
							archivedCount > 0
								? `\n\n(${archivedCount} archived; use 'memory search' to find and 'memory get' to restore.)`
								: "";
						const summary = all.length
							? `${all
									.map((e) => {
										const scopePrefix = combined && e.scope === "global" ? "[global] " : "";
										return `- ${scopePrefix}[${e.id}] (${e.category}${e.pinned ? ", pinned" : ""}) ${e.title}`;
									})
									.join("\n")}${archivedNote}`
							: archivedCount > 0
								? `No active memory entries (${archivedCount} archived; use 'memory search' to find and 'memory get' to restore).`
								: "No memory entries recorded yet.";
						return {
							content: [{ type: "text", text: summary }],
							details: {
								action: "list",
								scope: queryScope,
								entries: all,
								...(globalList !== undefined ? { globalEntries: globalList } : {}),
								...(archivedCount > 0 ? { archivedCount } : {}),
							} as MemoryToolDetails,
						};
					}
					default:
						throw new Error(`Unsupported action: ${params.action}`);
				}
			},

			renderCall: renderToolCall,
			renderResult: renderToolResult,
		});

		pi.registerCommand("memory", {
			description:
				"View and manage memory: /memory, /memory add <text>, /memory global add <text>, /memory rm <id>, /memory global rm <id>, /memory decay, /memory dream [status], /memory path",
			handler: async (args, ctx: ExtensionCommandContext) => {
				const projectStore = await ensureStore(ctx.cwd);
				const gStore = ensureGlobalStore();
				const trimmed = (args ?? "").trim();

				if (!trimmed) {
					const [entries, globalEntries] = await Promise.all([projectStore.listEntries(), gStore.listEntries()]);
					if (ctx.hasUI && ctx.mode === "tui") {
						await ctx.ui.custom<void>((_tui, theme, keybindings, done) => {
							return new MemoryListComponent(
								entries,
								projectStore.projectRoot,
								theme,
								keybindings,
								() => done(),
								globalEntries,
							);
						});
					} else {
						const sections: string[] = [];
						if (globalEntries.length > 0) {
							const lines = globalEntries.map(
								(e) => `[global] [${e.id}] (${e.category}${e.pinned ? ", pinned" : ""}) ${e.title}`,
							);
							sections.push(`Global Memories:\n${lines.join("\n")}`);
						}
						if (entries.length > 0) {
							const lines = entries.map(
								(e) => `[${e.id}] (${e.category}${e.pinned ? ", pinned" : ""}) ${e.title}`,
							);
							sections.push(`Project Memories:\n${lines.join("\n")}`);
						}
						if (sections.length === 0) {
							ctx.ui.notify("No memory entries for this project yet.", "info");
						} else {
							ctx.ui.notify(sections.join("\n\n"), "info");
						}
					}
					return;
				}

				if (trimmed === "global add" || trimmed.startsWith("global add ")) {
					const title = trimmed.slice("global add".length).trim();
					if (!title) {
						ctx.ui.notify("Usage: /memory global add <one-line text>", "error");
						return;
					}
					try {
						const entry = await gStore.addEntry({ title, category: "fact" });
						ctx.ui.notify(`Added global memory [${entry.id}]: ${entry.title}`, "info");
						notifyAgent(`added global [${entry.id}] (${entry.category}) "${entry.title}"`);
					} catch (err) {
						ctx.ui.notify(
							`Failed to add global memory: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					return;
				}

				if (
					trimmed === "global rm" ||
					trimmed === "global delete" ||
					trimmed.startsWith("global rm ") ||
					trimmed.startsWith("global delete ")
				) {
					const id = trimmed.replace(/^global\s+(rm|delete)\s*/, "").trim();
					if (!id) {
						ctx.ui.notify("Usage: /memory global rm <id>", "error");
						return;
					}
					try {
						const deleted = await gStore.deleteEntry(id);
						ctx.ui.notify(`Deleted global memory [${deleted.id}]: ${deleted.title}`, "info");
						notifyAgent(`deleted global [${deleted.id}] "${deleted.title}"; do not follow it`);
					} catch (err) {
						ctx.ui.notify(
							`Failed to delete global memory: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					return;
				}

				if (trimmed === "add" || trimmed.startsWith("add ")) {
					const title = trimmed.slice("add".length).trim();
					if (!title) {
						ctx.ui.notify("Usage: /memory add <one-line text>", "error");
						return;
					}
					try {
						const entry = await projectStore.addEntry({ title, category: "fact" });
						ctx.ui.notify(`Added memory [${entry.id}]: ${entry.title}`, "info");
						notifyAgent(`added [${entry.id}] (${entry.category}) "${entry.title}"`);
					} catch (err) {
						ctx.ui.notify(`Failed to add memory: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
					return;
				}

				if (
					trimmed === "rm" ||
					trimmed === "delete" ||
					trimmed.startsWith("rm ") ||
					trimmed.startsWith("delete ")
				) {
					const id = trimmed.replace(/^(rm|delete)\s*/, "").trim();
					if (!id) {
						ctx.ui.notify("Usage: /memory rm <id>", "error");
						return;
					}
					try {
						const deleted = await projectStore.deleteEntry(id);
						ctx.ui.notify(`Deleted memory [${deleted.id}]: ${deleted.title}`, "info");
						notifyAgent(`deleted [${deleted.id}] "${deleted.title}"; do not follow it`);
					} catch (err) {
						ctx.ui.notify(
							`Failed to delete memory: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					return;
				}

				if (trimmed === "decay") {
					const [projectEntries, globalEntries] = await Promise.all([
						projectStore.listEntries(),
						gStore.listEntries(),
					]);
					const projectResult = await projectStore.runDecay({ force: true, companionEntries: globalEntries });
					const globalResult = await gStore.runDecay({ force: true, companionEntries: projectEntries });
					const totalArchived = projectResult.archivedIds.length + globalResult.archivedIds.length;
					if (totalArchived === 0) {
						ctx.ui.notify(
							`Memory decay complete: no entries archived (project seq=${projectResult.sessionSeq}, global seq=${globalResult.sessionSeq}).`,
							"info",
						);
					} else {
						const parts: string[] = [];
						if (projectResult.archivedIds.length > 0) {
							parts.push(`project: ${projectResult.archivedIds.join(", ")}`);
						}
						if (globalResult.archivedIds.length > 0) {
							parts.push(`global: ${globalResult.archivedIds.join(", ")}`);
						}
						ctx.ui.notify(`Memory decay archived ${totalArchived} entry/entries (${parts.join("; ")}).`, "info");
					}
					return;
				}

				if (trimmed === "dream" || trimmed.startsWith("dream ")) {
					const dreamArg = trimmed.slice("dream".length).trim();
					if (dreamArg && dreamArg !== "status") {
						ctx.ui.notify(`Unknown dream option '${dreamArg}'. Usage: /memory dream [status]`, "warning");
						return;
					}

					if (dreamArg === "status") {
						try {
							const diagnostics = await collectDreamDiagnostics(projectStore, gStore);
							const timerState = dreamTurnActive
								? "running now"
								: idleTimer !== null && idleFireAtMs !== null
									? `armed (fires in ${formatDurationMs(idleFireAtMs - Date.now())})`
									: enableIdleDream
										? `idle (arms after turn for ${formatDurationMs(idleDreamMs)})`
										: "disabled";
							const lines = [
								`Dream status (project: ${projectStore.projectRoot}):`,
								`Session model: ${formatModelName(ctx.model)} | Dirty turns: ${dirtyTurnsSinceDream} | Idle timer: ${timerState}`,
								`Global memory: ${diagnostics.globalActiveCount} active, ${diagnostics.globalArchivedCount} archived`,
								`Project memory: ${diagnostics.projectActiveCount} active, ${diagnostics.projectArchivedCount} archived`,
							];
							if (diagnostics.brokenLinks.length > 0) {
								lines.push(`Broken links: ${diagnostics.brokenLinks.length}`);
							}
							ctx.ui.notify(lines.join("\n"), "info");
						} catch (err) {
							ctx.ui.notify(
								`Failed to check memory dream status: ${err instanceof Error ? err.message : String(err)}`,
								"error",
							);
						}
						return;
					}

					if (!ctx.model) {
						ctx.ui.notify("Memory dream requires an active model in the current session.", "warning");
						return;
					}

					cancelIdleTimer();
					try {
						const triggered = await triggerDream(ctx, "manual");
						if (
							triggered &&
							(ctx.mode === "print" || ctx.mode === "json") &&
							typeof ctx.waitForIdle === "function"
						) {
							await ctx.waitForIdle();
						}
					} catch (err) {
						ctx.ui.notify(`Memory dream failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
					return;
				}

				if (trimmed === "path") {
					ctx.ui.notify(
						`Project root: ${projectStore.projectRoot}\nProject memory directory: ${projectStore.memoryDir}\nGlobal memory directory: ${gStore.memoryDir}`,
						"info",
					);
					return;
				}

				ctx.ui.notify(
					"Unknown command. Usage: /memory, /memory add <text>, /memory global add <text>, /memory rm <id>, /memory global rm <id>, /memory decay, /memory dream [status], /memory path",
					"warning",
				);
			},
		});
	};
}

export default function memoryExtension(pi: ExtensionAPI): void {
	createMemoryExtension()(pi);
}
