/**
 * Built-in persistent inline todo list.
 *
 * The list is stored as session custom entries, so it follows the active
 * branch. Its widget is updated only when the list snapshot changes.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { defineTool } from "../../core/extensions/types.ts";
import { TodoManager } from "./manager.ts";
import {
	completedTodoCount,
	renderTodoLines,
	TODO_CONTEXT_CUSTOM_TYPE,
	TODO_CUSTOM_TYPE,
	TODO_STATUS_KEY,
	TODO_WIDGET_KEY,
	type TodoState,
} from "./state.ts";

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

export default function todoExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined;
	let lastRenderedSignature: string | undefined;

	const useCtx = (ctx: ExtensionContext): void => {
		currentCtx = ctx;
	};

	const renderWidget = (): void => {
		const ctx = currentCtx;
		if (!ctx || !ctx.hasUI) return;

		const state = manager.getState();
		// A completed list remains persisted for history, but no longer occupies
		// the editor area. It can still be inspected with /todo or get_todos.
		const lines = state && !state.items.every((item) => item.done) ? renderTodoLines(state, ctx.ui.theme) : undefined;
		const signature = lines === undefined ? "<hidden>" : lines.join("\n");
		if (signature === lastRenderedSignature) return;
		lastRenderedSignature = signature;

		ctx.ui.setWidget(TODO_WIDGET_KEY, lines);
		if (state && lines) {
			ctx.ui.setStatus(
				TODO_STATUS_KEY,
				ctx.ui.theme.fg("muted", `Todos ${completedTodoCount(state)}/${state.items.length}`),
			);
		} else {
			ctx.ui.setStatus(TODO_STATUS_KEY, undefined);
		}
	};

	const manager = new TodoManager({
		persist: (entry) =>
			pi.appendEntry<TodoState | { status: "cleared"; clearedAt: number; listId?: string }>(TODO_CUSTOM_TYPE, entry),
		notify: (message, type) => currentCtx?.ui.notify(message, type),
		onStateChange: renderWidget,
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
		lastRenderedSignature = undefined;
		manager.restore(ctx.sessionManager.getBranch());
	});

	pi.on("session_tree", async (_event, ctx) => {
		useCtx(ctx);
		lastRenderedSignature = undefined;
		manager.restore(ctx.sessionManager.getBranch());
	});

	pi.on("context", async (event, ctx) => {
		// Rebuild this message on every provider request. A list may change in a
		// tool call, a goal continuation, or a command; retaining the old hidden
		// snapshot would make the model act on stale checkboxes.
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
