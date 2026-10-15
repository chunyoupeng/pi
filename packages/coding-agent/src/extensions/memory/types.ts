export type MemoryCategory = "fact" | "decision" | "convention" | "gotcha";

export type MemoryAction = "add" | "update" | "delete" | "get" | "search" | "list";

export interface MemoryEntry {
	id: string;
	title: string;
	body?: string;
	category: MemoryCategory;
	pinned: boolean;
	created: string;
	updated: string;
}

export interface MemoryToolDetails {
	action: MemoryAction;
	entry?: MemoryEntry;
	entries?: MemoryEntry[];
	deletedId?: string;
	error?: string;
}
