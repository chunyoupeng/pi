/**
 * UI-independent controller for the persistent inline todo list.
 */

import type { SessionEntry } from "../../core/session-manager.ts";
import {
	buildTodoContextContent,
	cloneTodoState,
	createTodoState,
	formatTodoSummary,
	generateTodoId,
	isTodoComplete,
	loadTodoFromEntries,
	MAX_TODO_ITEM_CHARS,
	MAX_TODO_ITEMS,
	type TodoClearedMarker,
	type TodoState,
} from "./state.ts";

export type TodoMutationResult = "created" | "added" | "updated" | "cleared" | "refused" | "noop";

export interface TodoManagerOptions {
	persist: (entry: TodoState | TodoClearedMarker) => void;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
	onStateChange?: () => void;
	now?: () => number;
}

export class TodoManager {
	private state: TodoState | null = null;
	private readonly persist: TodoManagerOptions["persist"];
	private readonly notify: TodoManagerOptions["notify"];
	private readonly onStateChange: (() => void) | undefined;
	private readonly now: () => number;

	constructor(options: TodoManagerOptions) {
		this.persist = options.persist;
		this.notify = options.notify;
		this.onStateChange = options.onStateChange;
		this.now = options.now ?? (() => Date.now());
	}

	getState(): TodoState | null {
		return this.state ? cloneTodoState(this.state) : null;
	}

	restore(entries: readonly SessionEntry[]): void {
		this.state = loadTodoFromEntries(entries);
		this.onStateChange?.();
	}

	create(texts: readonly string[], overwrite = false): TodoMutationResult {
		const cleaned = texts.map((text) => text.trim()).filter((text) => text.length > 0);
		if (cleaned.length === 0) {
			this.notify("At least one todo item is required.", "warning");
			return "noop";
		}
		if (cleaned.length > MAX_TODO_ITEMS) {
			this.notify(`A todo list can contain at most ${MAX_TODO_ITEMS} items.`, "warning");
			return "noop";
		}
		if (cleaned.some((text) => text.length > MAX_TODO_ITEM_CHARS)) {
			this.notify(`Each todo item must be at most ${MAX_TODO_ITEM_CHARS} characters.`, "warning");
			return "noop";
		}
		if (this.state && !isTodoComplete(this.state) && !overwrite) {
			this.notify("An unfinished todo list already exists. Pass overwrite=true to replace it.", "warning");
			return "refused";
		}
		this.state = createTodoState(cleaned, this.now());
		this.commit(this.state);
		return "created";
	}

	add(text: string, listId: string): TodoMutationResult {
		const state = this.state;
		const cleaned = text.trim();
		if (!state) {
			this.notify("No todo list exists. Create one first.", "warning");
			return "noop";
		}
		if (state.listId !== listId) {
			this.notify(`Todo list ID mismatch: the current list is ${state.listId}.`, "error");
			return "noop";
		}
		if (!cleaned || cleaned.length > MAX_TODO_ITEM_CHARS || state.items.length >= MAX_TODO_ITEMS) {
			this.notify("The todo item is empty, too long, or the list is full.", "warning");
			return "noop";
		}
		const now = this.now();
		state.items.push({ id: generateTodoId(), text: cleaned, done: false, createdAt: now, updatedAt: now });
		state.revision++;
		this.commit(state);
		return "added";
	}

	update(itemId: string, status: "complete" | "pending", listId: string): TodoMutationResult {
		const state = this.state;
		if (!state) {
			this.notify("No todo list exists.", "warning");
			return "noop";
		}
		if (state.listId !== listId) {
			this.notify(`Todo list ID mismatch: the current list is ${state.listId}.`, "error");
			return "noop";
		}
		const item = state.items.find((candidate) => candidate.id === itemId);
		if (!item) {
			this.notify(`Todo item ${itemId} was not found.`, "warning");
			return "noop";
		}
		const done = status === "complete";
		if (item.done === done) return "noop";
		const now = this.now();
		item.done = done;
		item.updatedAt = now;
		item.completedAt = done ? now : undefined;
		state.revision++;
		this.commit(state);
		if (isTodoComplete(state)) this.notify("All todos complete.", "info");
		return "updated";
	}

	async clear(confirm: () => Promise<boolean>): Promise<TodoMutationResult> {
		const state = this.state;
		if (!state) {
			this.notify("No todo list to clear.", "info");
			return "noop";
		}
		if (!(await confirm())) return "refused";
		this.state = null;
		this.persist({ status: "cleared", clearedAt: this.now(), listId: state.listId });
		this.onStateChange?.();
		return "cleared";
	}

	formatSummary(): string {
		return this.state ? formatTodoSummary(this.state) : "No todo list. Create one with create_todo_list.";
	}

	buildContextContent(): string | null {
		const state = this.state;
		return state ? buildTodoContextContent(state) : null;
	}

	private commit(state: TodoState): void {
		state.updatedAt = this.now();
		this.persist(cloneTodoState(state));
		this.onStateChange?.();
	}
}
