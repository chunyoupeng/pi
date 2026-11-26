export type MemoryCategory = "fact" | "decision" | "convention" | "gotcha";

export type MemoryAction = "add" | "update" | "delete" | "get" | "search" | "list";

export type MemoryScope = "project" | "global";

export type MemoryQueryScope = "project" | "global" | "all";

export const GLOBAL_MEMORY_DIR_NAME = "--global--";
export const GLOBAL_CHAR_BUDGET = 3000;
export const PROJECT_CHAR_BUDGET = 8000;

export interface MemoryEntry {
	id: string;
	title: string;
	body?: string;
	category: MemoryCategory;
	pinned: boolean;
	created: string;
	updated: string;
	scope?: MemoryScope;
	archived?: boolean;
}

export interface MemoryLinks {
	linked: MemoryEntry[];
	missing: string[];
	linkedFrom: MemoryEntry[];
}

export interface MemoryToolDetails {
	action: MemoryAction;
	scope?: MemoryQueryScope;
	entry?: MemoryEntry;
	entries?: MemoryEntry[];
	globalEntries?: MemoryEntry[];
	links?: MemoryLinks;
	deletedId?: string;
	archivedCount?: number;
	error?: string;
}
