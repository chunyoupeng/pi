import { getCurrentSystemMessage, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { MemoryListComponent, renderPromptSection, renderToolCall, renderToolResult } from "./render.ts";
import { MemoryStore, parseLinks, resolveProjectRoot } from "./store.ts";
import type { MemoryCategory, MemoryEntry, MemoryLinks, MemoryToolDetails } from "./types.ts";

const CATEGORIES: readonly MemoryCategory[] = ["fact", "decision", "convention", "gotcha"] as const;
const ACTIONS = ["add", "update", "delete", "get", "search", "list"] as const;
const MEMORY_UPDATE_CUSTOM_TYPE = "memory-update";

const MemoryParams = Type.Object({
	action: StringEnum(ACTIONS, {
		description: "Action to perform: add, update, delete, get, search, list",
	}),
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

function formatLinkIds(entry: MemoryEntry): string {
	const ids = parseLinks(entry.body);
	return ids.length ? ` -> ${ids.map((id) => `[[${id}]]`).join(", ")}` : "";
}

// Linked entries come with their bodies so one `get` covers the neighborhood; linkers stay titles only.
function formatLinks(links: MemoryLinks): string {
	let text = "";
	if (links.linked.length) {
		const linked = links.linked.map((e) => `[${e.id}] (${e.category}) ${e.title}${e.body ? `\n${e.body}` : ""}`);
		text += `\n\nLinked entries:\n\n${linked.join("\n\n")}`;
	}
	if (links.missing.length) {
		text += `\n\nMissing links: ${links.missing.map((id) => `[[${id}]]`).join(", ")}`;
	}
	if (links.linkedFrom.length) {
		text += `\n\nLinked from:\n${links.linkedFrom.map((e) => `- [${e.id}] (${e.category}) ${e.title}`).join("\n")}`;
	}
	return text;
}

export default function memoryExtension(pi: ExtensionAPI): void {
	let store: MemoryStore | null = null;
	const rootByCwd = new Map<string, string>();
	let frozenSection: string | null = null;
	let reuseTranscriptSection = false;

	const ensureStore = async (cwd: string): Promise<MemoryStore> => {
		let root = rootByCwd.get(cwd);
		if (root === undefined) {
			root = await resolveProjectRoot(cwd);
			rootByCwd.set(cwd, root);
		}
		if (!store || store.projectRoot !== root) store = new MemoryStore(root);
		return store;
	};

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
	pi.on("session_start", async (event) => {
		frozenSection = null;
		reuseTranscriptSection = event.reason === "reload" || event.reason === "fork";
	});

	// Compaction already rewrites the conversation, and the tool results that recorded this
	// session's memory writes may now be summarized away.
	pi.on("session_compact", async () => {
		frozenSection = null;
		reuseTranscriptSection = false;
	});

	// Freeze <project_memory> between refresh points so mid-session memory writes never mutate
	// the system prompt prefix or invalidate the KV cache.
	pi.on("before_agent_start", async (event, ctx) => {
		if (frozenSection === null) {
			const existingTag = reuseTranscriptSection
				? getCurrentSystemMessage(ctx.sessionManager.buildSessionProjection().messages)?.sections?.project_memory
				: undefined;
			if (typeof existingTag === "string") {
				frozenSection = existingTag.replace(/^<project_memory>\n?/u, "").replace(/\n?<\/project_memory>$/u, "");
			} else {
				const currentStore = await ensureStore(ctx.cwd);
				frozenSection = renderPromptSection(currentStore.projectRoot, await currentStore.listEntries());
			}
		}
		event.systemPromptOptions.sections.project_memory = frozenSection;
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
			"Name each entry with a kebab-case id that says what it is (e.g. npm-check-skips-tests). When an entry refines, depends on, or contrasts with another, link it in body as [[other-id]]; `get` returns linked entries one hop away.",
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
						id: params.id,
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
					const { linkedFrom } = await s.findLinks(entry);
					const dangling = linkedFrom.length
						? `\n\nStill linked from ${linkedFrom.map((e) => `[${e.id}]`).join(", ")}; update their bodies.`
						: "";
					return {
						content: [
							{
								type: "text",
								text: `Deleted project memory [${entry.id}]: "${entry.title}"${dangling}`,
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
					const links = await s.findLinks(entry);
					return {
						content: [
							{
								type: "text",
								text: `Memory [${entry.id}] (${entry.category}${entry.pinned ? ", pinned" : ""})\nTitle: ${entry.title}\nUpdated: ${entry.updated}${entry.body ? `\n\n${entry.body}` : ""}${formatLinks(links)}`,
							},
						],
						details: { action: "get", entry, links } as MemoryToolDetails,
					};
				}
				case "search": {
					if (!params.query) {
						throw new Error("Parameter 'query' is required for action 'search'");
					}
					const results = await s.searchEntries(params.query);
					const summary = results.length
						? results.map((e) => `- [${e.id}] (${e.category}) ${e.title}${formatLinkIds(e)}`).join("\n")
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
					notifyAgent(`added [${entry.id}] (${entry.category}) "${entry.title}"`);
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
					notifyAgent(`deleted [${deleted.id}] "${deleted.title}"; do not follow it`);
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
