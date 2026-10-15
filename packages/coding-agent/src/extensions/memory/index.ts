import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { MemoryListComponent, renderPromptSection, renderToolCall, renderToolResult } from "./render.ts";
import { MemoryStore, resolveProjectRoot } from "./store.ts";
import type { MemoryCategory, MemoryToolDetails } from "./types.ts";

const CATEGORIES: readonly MemoryCategory[] = ["fact", "decision", "convention", "gotcha"] as const;
const ACTIONS = ["add", "update", "delete", "get", "search", "list"] as const;
const MEMORY_HINT_CUSTOM_TYPE = "memory-hint";
const CORRECTION_OR_RULE_PATTERN =
	/不要|禁止|以后|记住|优先|默认|规范|约定|别用|不准|必须|统一用|改成用|不要用|别跑|文件在|never\b|always\b|prefer\b|convention\b|do not\b|don't\b|instead of\b|from now on\b/i;

const MemoryParams = Type.Object({
	action: StringEnum(ACTIONS, {
		description: "Action to perform: add, update, delete, get, search, list",
	}),
	id: Type.Optional(Type.String({ description: "Entry ID (required for update, delete, get)" })),
	title: Type.Optional(Type.String({ description: "One-line summary title (required for add)" })),
	body: Type.Optional(Type.String({ description: "Detailed description, rationale, or context" })),
	category: Type.Optional(
		StringEnum(CATEGORIES, {
			description:
				"Category: fact (general truth), decision (architecture/choice), convention (standards/commands), gotcha (pitfalls)",
		}),
	),
	pinned: Type.Optional(Type.Boolean({ description: "Whether to always include the full body in prompt context" })),
	query: Type.Optional(Type.String({ description: "Search query string (for search action)" })),
});

export default function memoryExtension(pi: ExtensionAPI): void {
	let store: MemoryStore | null = null;

	const ensureStore = async (cwd: string): Promise<MemoryStore> => {
		if (store) return store;
		const root = await resolveProjectRoot(cwd);
		store = new MemoryStore(root);
		store.init();
		return store;
	};

	pi.on("session_start", async (_event, ctx) => {
		await ensureStore(ctx.cwd);
	});

	// Keep only the newest hidden memory-hint message in provider context so
	// earlier turns do not accumulate duplicate reminder messages.
	pi.on("context", async (event) => {
		let newestHintIndex = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message?.role === "custom" && message.customType === MEMORY_HINT_CUSTOM_TYPE) {
				newestHintIndex = i;
				break;
			}
		}
		if (newestHintIndex < 0) return;
		return {
			messages: event.messages.filter((message, index) => {
				return (
					message.role !== "custom" || message.customType !== MEMORY_HINT_CUSTOM_TYPE || index === newestHintIndex
				);
			}),
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const currentStore = await ensureStore(ctx.cwd);
		const entries = await currentStore.listEntries();
		const section = renderPromptSection(currentStore.projectRoot, entries);
		event.systemPromptOptions.sections.project_memory = section;

		if (event.messageType === "user" && CORRECTION_OR_RULE_PATTERN.test(event.prompt)) {
			return {
				message: {
					customType: MEMORY_HINT_CUSTOM_TYPE,
					display: false,
					content:
						"[System reminder: The user's message appears to state a project convention, workflow preference, architectural decision, or correction. If it is a durable rule or fact for this repository, proactively call the `memory` tool (action='add' or 'update') in this turn without waiting to be asked.]",
				},
			};
		}
	});

	pi.registerTool({
		name: "memory",
		label: "Project Memory",
		description:
			"Read and write persistent memory for the current project. Proactively use this to record durable facts, architectural decisions, conventions, and resolved gotchas across sessions without waiting to be asked.",
		promptSnippet: "Read and write persistent memory for the current project",
		promptGuidelines: [
			"PROACTIVE MEMORY: Do not wait for the user to say 'remember'. Call `memory` (action='add' or 'update') IMMEDIATELY in the same turn whenever any of these triggers happen:",
			"1. User correction / preference: The user corrects your approach, rejects a pattern, or states a workflow/architectural rule (e.g. 'don't run X', 'always put Y in Z'). Record it BEFORE or WHILE applying the fix.",
			"2. Non-obvious command: You discover through trial/error or scripts how to build, test, lint, or run a specific part of this repo.",
			"3. Root-cause gotcha: You hit a subtle bug, environment trap, or build failure and find the non-obvious root cause.",
			"4. Architectural decision: You and the user settle on a design choice, module boundary, or convention.",
			"Before ending a turn where you fixed a non-obvious gotcha or received user feedback, check <project_memory> and record or update the entry.",
			"Do not store: current task progress, things obvious from reading the code, secrets or credentials, guesses you have not verified.",
			"Before adding, check <project_memory> for an existing entry; prefer update over a near-duplicate add. Keep title to one line and put detail in body.",
		],
		parameters: MemoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const s = await ensureStore(ctx.cwd);
			switch (params.action) {
				case "add": {
					if (!params.title) {
						throw new Error("Parameter 'title' is required for action 'add'");
					}
					const entry = await s.addEntry({
						title: params.title,
						body: params.body,
						category: params.category,
						pinned: params.pinned,
					});
					return {
						content: [
							{
								type: "text",
								text: `Recorded project memory [${entry.id}] (${entry.category}): "${entry.title}"${entry.body ? `\n\n${entry.body}` : ""}`,
							},
						],
						details: { action: "add", entry } as MemoryToolDetails,
					};
				}
				case "update": {
					if (!params.id) {
						throw new Error("Parameter 'id' is required for action 'update'");
					}
					const entry = await s.updateEntry(params.id, {
						title: params.title,
						body: params.body,
						category: params.category,
						pinned: params.pinned,
					});
					return {
						content: [
							{
								type: "text",
								text: `Updated project memory [${entry.id}] (${entry.category}): "${entry.title}"`,
							},
						],
						details: { action: "update", entry } as MemoryToolDetails,
					};
				}
				case "delete": {
					if (!params.id) {
						throw new Error("Parameter 'id' is required for action 'delete'");
					}
					const entry = await s.deleteEntry(params.id);
					return {
						content: [
							{
								type: "text",
								text: `Deleted project memory [${entry.id}]: "${entry.title}"`,
							},
						],
						details: { action: "delete", deletedId: params.id, entry } as MemoryToolDetails,
					};
				}
				case "get": {
					if (!params.id) {
						throw new Error("Parameter 'id' is required for action 'get'");
					}
					const entry = await s.getEntry(params.id);
					if (!entry) {
						return {
							content: [{ type: "text", text: `Memory entry [${params.id}] not found.` }],
							details: { action: "get", error: "Not found" } as MemoryToolDetails,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Memory [${entry.id}] (${entry.category}${entry.pinned ? ", pinned" : ""})\nTitle: ${entry.title}\nUpdated: ${entry.updated}${entry.body ? `\n\n${entry.body}` : ""}`,
							},
						],
						details: { action: "get", entry } as MemoryToolDetails,
					};
				}
				case "search": {
					if (!params.query) {
						throw new Error("Parameter 'query' is required for action 'search'");
					}
					const results = await s.searchEntries(params.query);
					const summary = results.length
						? results.map((e) => `- [${e.id}] (${e.category}) ${e.title}`).join("\n")
						: "No matching memory entries found.";
					return {
						content: [{ type: "text", text: summary }],
						details: { action: "search", entries: results } as MemoryToolDetails,
					};
				}
				case "list": {
					const all = await s.listEntries();
					const summary = all.length
						? all.map((e) => `- [${e.id}] (${e.category}${e.pinned ? ", pinned" : ""}) ${e.title}`).join("\n")
						: "No memory entries recorded yet.";
					return {
						content: [{ type: "text", text: summary }],
						details: { action: "list", entries: all } as MemoryToolDetails,
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
		description: "View and manage project memory: /memory, /memory add <text>, /memory rm <id>, /memory path",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const s = await ensureStore(ctx.cwd);
			const trimmed = (args ?? "").trim();

			if (!trimmed) {
				const entries = await s.listEntries();
				if (ctx.hasUI && ctx.mode === "tui") {
					await ctx.ui.custom<void>((_tui, theme, keybindings, done) => {
						return new MemoryListComponent(entries, s.projectRoot, theme, keybindings, () => done());
					});
				} else {
					if (entries.length === 0) {
						ctx.ui.notify("No memory entries for this project yet.", "info");
					} else {
						const lines = entries.map((e) => `[${e.id}] (${e.category}${e.pinned ? ", pinned" : ""}) ${e.title}`);
						ctx.ui.notify(`Project Memories:\n${lines.join("\n")}`, "info");
					}
				}
				return;
			}

			if (trimmed.startsWith("add ")) {
				const title = trimmed.slice(4).trim();
				if (!title) {
					ctx.ui.notify("Usage: /memory add <one-line text>", "error");
					return;
				}
				try {
					const entry = await s.addEntry({ title, category: "fact" });
					ctx.ui.notify(`Added memory [${entry.id}]: ${entry.title}`, "info");
				} catch (err) {
					ctx.ui.notify(`Failed to add memory: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (trimmed.startsWith("rm ") || trimmed.startsWith("delete ")) {
				const id = trimmed.replace(/^(rm|delete)\s+/, "").trim();
				if (!id) {
					ctx.ui.notify("Usage: /memory rm <id>", "error");
					return;
				}
				try {
					const deleted = await s.deleteEntry(id);
					ctx.ui.notify(`Deleted memory [${deleted.id}]: ${deleted.title}`, "info");
				} catch (err) {
					ctx.ui.notify(`Failed to delete memory: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (trimmed === "path") {
				ctx.ui.notify(`Project root: ${s.projectRoot}\nMemory directory: ${s.memoryDir}`, "info");
				return;
			}

			ctx.ui.notify("Unknown command. Usage: /memory, /memory add <text>, /memory rm <id>, /memory path", "warning");
		},
	});
}
