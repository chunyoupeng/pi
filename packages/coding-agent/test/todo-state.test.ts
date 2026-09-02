import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	buildTodoContextContent,
	createTodoState,
	isTodoComplete,
	isTodoState,
	loadTodoFromEntries,
	renderTodoLines,
	type TodoState,
} from "../src/extensions/todo/state.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => `~~${text}~~`,
};

function entry(data: unknown): SessionEntry {
	return { type: "custom", customType: "todo-list", data } as unknown as SessionEntry;
}

describe("todo state", () => {
	it("creates unchecked items and renders a compact panel", () => {
		const state = createTodoState(["Inspect code", "Run checks"], 1000);
		expect(state.items.every((item) => !item.done)).toBe(true);
		expect(renderTodoLines(state, theme as never)).toEqual([
			"  ┌─ TODO LIST · 0/2",
			"  │ ☐ Inspect code",
			"  │ ☐ Run checks",
			"  └─ 2 remaining",
		]);
	});

	it("renders checked items and a done state", () => {
		const state = createTodoState(["Ship it"], 1000);
		state.items[0]!.done = true;
		expect(isTodoComplete(state)).toBe(true);
		expect(renderTodoLines(state, theme as never)).toEqual([
			"  ┌─ ✓ TODO DONE · 1/1",
			"  │ ☑ ~~Ship it~~",
			"  └─ All tasks complete",
		]);
		expect(buildTodoContextContent(state)).toBeNull();
	});

	it("restores the newest snapshot and respects a cleared marker", () => {
		const state = createTodoState(["Keep me"], 1000);
		expect(loadTodoFromEntries([entry(state)])?.listId).toBe(state.listId);
		expect(loadTodoFromEntries([entry(state), entry({ status: "cleared", clearedAt: 2000 })])).toBeNull();
		expect(isTodoState({ ...state, items: [] })).toBe(false);
	});

	it("provides current task IDs to the hidden context", () => {
		const state: TodoState = createTodoState(["First"], 1000);
		const content = buildTodoContextContent(state);
		expect(content).toContain(state.listId);
		expect(content).toContain(state.items[0]!.id);
		expect(content).toContain("update_todo_item");
	});
});
