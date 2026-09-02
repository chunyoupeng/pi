import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import todoExtension from "../src/extensions/todo/index.ts";

interface Harness {
	handlers: Map<string, (...args: unknown[]) => unknown>;
	tools: Map<
		string,
		{
			execute: (
				...args: unknown[]
			) => Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
			renderResult?: (...args: unknown[]) => { render: (width: number) => string[] };
		}
	>;
	entries: Array<{ data: unknown }>;
	setWidget: ReturnType<typeof vi.fn>;
	makeCtx: (branch?: SessionEntry[], hasUI?: boolean) => ExtensionContext;
}

function setup(): Harness {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const tools = new Map<
		string,
		{
			execute: (
				...args: unknown[]
			) => Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
			renderResult?: (...args: unknown[]) => { render: (width: number) => string[] };
		}
	>();
	const entries: Array<{ data: unknown }> = [];
	const setWidget = vi.fn();
	const setStatus = vi.fn();
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<never> }) =>
			tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		appendEntry: (_type: string, data: unknown) => entries.push({ data }),
	} as unknown as ExtensionAPI;
	todoExtension(pi);
	const makeCtx = (branch: SessionEntry[] = [], hasUI = true): ExtensionContext =>
		({
			mode: hasUI ? "tui" : "print",
			hasUI,
			ui: {
				setWidget,
				setStatus,
				notify: vi.fn(),
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
					strikethrough: (text: string) => text,
				},
			},
			sessionManager: { getBranch: () => branch },
		}) as unknown as ExtensionContext;
	return { handlers, tools, entries, setWidget, makeCtx };
}

describe("todo extension", () => {
	it("renders every todo tool result as a transcript snapshot", async () => {
		const h = setup();
		const ctx = h.makeCtx();
		await h.handlers.get("session_start")!({}, ctx);
		const create = h.tools.get("create_todo_list")!;
		const createResult = await create.execute("call", { items: ["Build UI"] }, undefined, undefined, ctx);
		const renderedCreate = create.renderResult!(createResult, {}, ctx.ui.theme, {});
		expect(renderedCreate.render(80).map((line) => line.trimEnd())).toEqual([
			"  ┌─ TODO LIST · 0/1",
			"  │ ☐ Build UI",
			"  └─ 1 remaining",
		]);

		const state = h.entries[0]!.data as { listId: string; items: Array<{ id: string }> };
		const update = h.tools.get("update_todo_item")!;
		const updateResult = await update.execute(
			"update",
			{ listId: state.listId, itemId: state.items[0]!.id, status: "complete" },
			undefined,
			undefined,
			ctx,
		);
		const renderedUpdate = update.renderResult!(updateResult, {}, ctx.ui.theme, {});
		expect(renderedUpdate.render(80).map((line) => line.trimEnd())).toEqual([
			"  ┌─ ✓ TODO DONE · 1/1",
			"  │ ☑ Build UI",
			"  └─ All tasks complete",
		]);
		expect(h.setWidget).not.toHaveBeenCalled();
	});

	it("keeps the final checked snapshot visible", async () => {
		const h = setup();
		const ctx = h.makeCtx();
		const create = h.tools.get("create_todo_list")!;
		const result = await create.execute("call", { items: ["Build UI"] }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("listId:");
		const state = h.entries[0]!.data as { listId: string; items: Array<{ id: string }> };
		const update = h.tools.get("update_todo_item")!;
		const updateResult = await update.execute(
			"call-2",
			{ listId: state.listId, itemId: state.items[0]!.id, status: "complete" },
			undefined,
			undefined,
			ctx,
		);
		const rendered = update.renderResult!(updateResult, {}, ctx.ui.theme, {});
		expect(rendered.render(80).map((line) => line.trimEnd())).toEqual([
			"  ┌─ ✓ TODO DONE · 1/1",
			"  │ ☑ Build UI",
			"  └─ All tasks complete",
		]);
	});

	it("replaces stale hidden context with the current snapshot", async () => {
		const h = setup();
		const ctx = h.makeCtx();
		const create = h.tools.get("create_todo_list")!;
		await create.execute("call", { items: ["Build UI"] }, undefined, undefined, ctx);
		const before = (await h.handlers.get("before_agent_start")!({}, ctx)) as { message: { content: string } };
		const context = (await h.handlers.get("context")!(
			{
				messages: [
					{ role: "user", content: "work", timestamp: 1 },
					{
						role: "custom",
						customType: "todo-list-context",
						content: before.message.content,
						display: false,
						timestamp: 2,
					},
				],
			},
			ctx,
		)) as { messages: Array<{ customType?: string; content?: string }> };
		expect(context.messages.filter((message) => message.customType === "todo-list-context")).toHaveLength(1);
		await h.tools.get("update_todo_item")!.execute(
			"call-2",
			{
				listId: (h.entries[0]!.data as { listId: string }).listId,
				itemId: (h.entries[0]!.data as { items: Array<{ id: string }> }).items[0]!.id,
				status: "complete",
			},
			undefined,
			undefined,
			ctx,
		);
		const completed = (await h.handlers.get("context")!({ messages: context.messages }, ctx)) as {
			messages: Array<{ customType?: string }>;
		};
		expect(completed.messages.some((message) => message.customType === "todo-list-context")).toBe(false);
	});
});
