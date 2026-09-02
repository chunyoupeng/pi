/**
 * Inline todo list state, persistence, and rendering helpers.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export const TODO_CUSTOM_TYPE = "todo-list";
export const TODO_CONTEXT_CUSTOM_TYPE = "todo-list-context";
export const TODO_WIDGET_KEY = "todo-list";
export const TODO_STATUS_KEY = "todo-list";
export const TODO_SCHEMA_VERSION = 1;
export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_ITEM_CHARS = 500;

export interface TodoItem {
	id: string;
	text: string;
	done: boolean;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
}

export interface TodoState {
	version: typeof TODO_SCHEMA_VERSION;
	listId: string;
	revision: number;
	items: TodoItem[];
	createdAt: number;
	updatedAt: number;
}

export interface TodoClearedMarker {
	status: "cleared";
	clearedAt: number;
	listId?: string;
}

const TODO_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateTodoId(): string {
	let id = "";
	const bytes = new Uint8Array(8);
	if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function") {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	for (const byte of bytes) id += TODO_ID_ALPHABET[byte % TODO_ID_ALPHABET.length];
	return id;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function isTodoState(value: unknown): value is TodoState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	if (
		state.version !== TODO_SCHEMA_VERSION ||
		typeof state.listId !== "string" ||
		state.listId.length === 0 ||
		typeof state.revision !== "number" ||
		!Number.isSafeInteger(state.revision) ||
		state.revision < 1 ||
		!Array.isArray(state.items) ||
		state.items.length === 0 ||
		state.items.length > MAX_TODO_ITEMS ||
		!isFiniteNumber(state.createdAt) ||
		!isFiniteNumber(state.updatedAt)
	) {
		return false;
	}

	return state.items.every((value) => {
		if (typeof value !== "object" || value === null) return false;
		const item = value as Record<string, unknown>;
		return (
			typeof item.id === "string" &&
			item.id.length > 0 &&
			typeof item.text === "string" &&
			item.text.trim().length > 0 &&
			item.text.length <= MAX_TODO_ITEM_CHARS &&
			typeof item.done === "boolean" &&
			isFiniteNumber(item.createdAt) &&
			isFiniteNumber(item.updatedAt) &&
			(item.completedAt === undefined || isFiniteNumber(item.completedAt))
		);
	});
}

export function isTodoClearedMarker(value: unknown): value is TodoClearedMarker {
	if (typeof value !== "object" || value === null) return false;
	const marker = value as Record<string, unknown>;
	return marker.status === "cleared" && isFiniteNumber(marker.clearedAt);
}

export function loadTodoFromEntries(entries: readonly SessionEntry[]): TodoState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== TODO_CUSTOM_TYPE) continue;
		if (entry.data === undefined || entry.data === null || isTodoClearedMarker(entry.data)) return null;
		if (isTodoState(entry.data)) return entry.data;
	}
	return null;
}

export function createTodoState(texts: readonly string[], now: number = Date.now()): TodoState {
	return {
		version: TODO_SCHEMA_VERSION,
		listId: generateTodoId(),
		revision: 1,
		items: texts.map((text) => ({
			id: generateTodoId(),
			text: text.trim(),
			done: false,
			createdAt: now,
			updatedAt: now,
		})),
		createdAt: now,
		updatedAt: now,
	};
}

export function cloneTodoState(state: TodoState): TodoState {
	return {
		...state,
		items: state.items.map((item) => ({ ...item })),
	};
}

export function completedTodoCount(state: TodoState): number {
	return state.items.filter((item) => item.done).length;
}

export function isTodoComplete(state: TodoState): boolean {
	return state.items.length > 0 && state.items.every((item) => item.done);
}

/**
 * Render a compact panel above the editor. The initial state deliberately uses
 * only empty boxes; completed items change to checked boxes and are crossed out.
 */
export function renderTodoLines(state: TodoState, theme: Theme): string[] {
	const completed = completedTodoCount(state);
	const total = state.items.length;
	const complete = completed === total;
	const title = complete ? "✓ TODO DONE" : "TODO LIST";
	const titleColor = complete ? "success" : "accent";
	const progress = `${completed}/${total}`;

	const lines = [
		theme.fg("borderMuted", "  ┌─ ") + theme.fg(titleColor, theme.bold(title)) + theme.fg("muted", ` · ${progress}`),
	];

	for (const item of state.items) {
		const check = item.done ? theme.fg("success", "☑") : theme.fg("dim", "☐");
		const itemText = truncateToWidth(item.text, 120);
		const text = item.done ? theme.fg("muted", theme.strikethrough(itemText)) : theme.fg("text", itemText);
		lines.push(`${theme.fg("borderMuted", "  │")} ${check} ${text}`);
	}

	lines.push(
		theme.fg("borderMuted", "  └─ ") +
			(complete ? theme.fg("success", "All tasks complete") : theme.fg("dim", `${total - completed} remaining`)),
	);
	return lines;
}

export function buildTodoContextContent(state: TodoState): string | null {
	if (isTodoComplete(state)) return null;
	const remaining = state.items.filter((item) => !item.done);
	return [
		"[Hidden todo list context - generated by the todo extension.]",
		"",
		`Todo list ID: ${state.listId}`,
		"Tasks:",
		...state.items.map((item) => `- ${item.id} [${item.done ? "done" : " "}] ${item.text}`),
		"",
		`Remaining: ${remaining.length}/${state.items.length}`,
		'Work through the tasks in order. After completing a task, call update_todo_item with its itemId and status "complete".',
		"Do not call update_todo_item until the task is actually complete and verified.",
	].join("\n");
}

export function formatTodoSummary(state: TodoState): string {
	const completed = completedTodoCount(state);
	return [
		`Todo list (${completed}/${state.items.length})`,
		...state.items.map((item) => `[${item.done ? "x" : " "}] ${item.id}: ${item.text}`),
	].join("\n");
}
