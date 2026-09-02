/**
 * Built-in persistent inline todo list.
 *
 * The list is stored as session custom entries, so it follows the active
 * branch. Each tool result renders the current list snapshot in the chat
 * transcript; snapshots are not replaced by a live widget.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../../core/extensions/types.ts";
import { defineTool } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { TodoManager } from "./manager.ts";
import { isTodoState, renderTodoLines, TODO_CONTEXT_CUSTOM_TYPE, TODO_CUSTOM_TYPE, type TodoState } from "./state.ts";

const CreateTodoListParams = Type.Object({
	items: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Todo items in execution order." }),
	overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing unfinished list." })),
});

const UpdateTodoItemParams = Type.Object({
	listId: Type.String({ description: "The listId returned by get_todos." }),
	itemId: Type.String({ description: "The itemId returned by get_todos." }),
	status: StringEnum(["complete", "pending"] as const),
});

const AddTodoItemParams = Type.Object({
	listId: Type.String({ description: "The listId returned by get_todos." }),
	text: Type.String({ minLength: 1, description: "The new todo item." }),
});

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function renderTodoResult(result: AgentToolResult<unknown>, theme: Theme): Text {
	if (isTodoState(result.details)) {
		return new Text(renderTodoLines(result.details, theme).join("\n"), 0, 0);
	}

	const text = result.content.find((content) => content.type === "text")?.text ?? "";
	return new Text(text, 0, 0);
}

export default function todoExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined;

	const useCtx = (ctx: ExtensionContext): void => {
		currentCtx = ctx;
	};

	const manager = new TodoManager({
		persist: (entry) =>
			pi.appendEntry<TodoState | { status: "cleared"; clearedAt: number; listId?: string }>(TODO_CUSTOM_TYPE, entry),
		notify: (message, type) => currentCtx?.ui.notify(message, type),
	});

	pi.registerTool(
		defineTool({
			name: "get_todos",
			label: "Get todos",
			description: "Get the current inline todo list, including stable list and item IDs.",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				useCtx(ctx);
				const state = manager.getState();
				return textResult(state ? JSON.stringify(state, null, 2) : "null", state ? { ...state } : {});
			},
			renderResult(result, _options, theme) {
				return renderTodoResult(result, theme);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "create_todo_list",
			label: "Create todo list",
			description:
				"Create an inline todo list in execution order. Use this only when the user explicitly asks for a todo list or asks to track a multi-step task.",
			parameters: CreateTodoListParams,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				useCtx(ctx);
				const result = manager.create(params.items, params.overwrite ?? false);
				const state = manager.getState();
				return {
					...textResult(
						result === "created" && state
							? `Todo list created (listId: ${state.listId}). Items: ${state.items.map((item) => `${item.id}: ${item.text}`).join("; ")}`
							: result === "refused"
								? "An unfinished todo list already exists. Ask the user before replacing it."
								: "Todo list was not created.",
						state ? { ...state } : {},
					),
					isError: result === "refused" || result === "noop",
				};
			},
			renderResult(result, _options, theme) {
				return renderTodoResult(result, theme);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "add_todo_item",
			label: "Add todo item",
			description: "Add one unchecked item to the current inline todo list.",
			parameters: AddTodoItemParams,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				useCtx(ctx);
				const result = manager.add(params.text, params.listId);
				const state = manager.getState();
				return {
					...textResult(
						result === "added" && state
							? `Todo item added (itemId: ${state.items[state.items.length - 1]?.id ?? "unknown"}).`
							: "Todo item was not added.",
						state ? { ...state } : {},
					),
					isError: result !== "added",
				};
			},
			renderResult(result, _options, theme) {
				return renderTodoResult(result, theme);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "update_todo_item",
			label: "Update todo item",
			description: "Mark a todo item complete only after it is actually completed and verified.",
			parameters: UpdateTodoItemParams,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				useCtx(ctx);
				const result = manager.update(params.itemId, params.status, params.listId);
				const state = manager.getState();
				return {
					...textResult(
						result === "updated" ? `Todo item marked ${params.status}.` : "Todo item was not updated.",
						state ? { ...state } : {},
					),
					isError: result !== "updated" && result !== "noop",
				};
			},
			renderResult(result, _options, theme) {
				return renderTodoResult(result, theme);
			},
		}),
	);

	const showSummary = (ctx: ExtensionCommandContext): void => {
		const summary = manager.formatSummary();
		if (ctx.mode === "print") console.log(summary);
		else ctx.ui.notify(summary, "info");
	};

	pi.registerCommand("todo", {
		description: "Show or manage the inline todo list: /todo, /todo clear",
		handler: async (args, ctx) => {
			useCtx(ctx);
			const command = args.trim().toLowerCase();
			if (!command || command === "show") {
				showSummary(ctx);
				return;
			}
			if (command === "clear") {
				await manager.clear(() =>
					ctx.hasUI ? ctx.ui.confirm("Clear todo list?", "Remove the current todo list?") : Promise.resolve(true),
				);
				return;
			}
			ctx.ui.notify("Usage: /todo [show|clear]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		useCtx(ctx);
		manager.restore(ctx.sessionManager.getBranch());
	});

	pi.on("session_tree", async (_event, ctx) => {
		useCtx(ctx);
		manager.restore(ctx.sessionManager.getBranch());
	});

	pi.on("context", async (event, ctx) => {
		// Rebuild this message on every provider request so the model sees the
		// current state after every tool update.
		useCtx(ctx);
		const existingIndex = event.messages.findIndex(
			(message) => message.role === "custom" && message.customType === TODO_CONTEXT_CUSTOM_TYPE,
		);
		const messages = event.messages.filter(
			(message) => message.role !== "custom" || message.customType !== TODO_CONTEXT_CUSTOM_TYPE,
		);
		const content = manager.buildContextContent();
		if (!content) return { messages };
		const contextMessage = {
			role: "custom" as const,
			customType: TODO_CONTEXT_CUSTOM_TYPE,
			content,
			display: false,
			timestamp: Date.now(),
		};
		const insertAt = existingIndex < 0 ? messages.length : Math.min(existingIndex, messages.length);
		messages.splice(insertAt, 0, contextMessage);
		return { messages };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		useCtx(ctx);
		const content = manager.buildContextContent();
		if (!content) return;
		return { message: { customType: TODO_CONTEXT_CUSTOM_TYPE, content, display: false } };
	});
}
