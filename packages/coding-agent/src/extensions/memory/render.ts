import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { MemoryEntry, MemoryToolDetails } from "./types.ts";

function formatIndexLine(entry: MemoryEntry): string {
	return `- [${entry.id}] (${entry.category}${entry.pinned ? ", pinned" : ""}) ${entry.title}\n`;
}

const OMITTED_NOTE_RESERVE = 70;

/**
 * Every entry's title goes in first so the model can see what exists and update instead of
 * duplicating; only pinned entries spend the remaining budget on their bodies.
 */
export function renderPromptSection(projectRoot: string, entries: MemoryEntry[], charBudget = 8000): string {
	const header = `Project: ${projectRoot}\nMemory index (pinned entries include their body; bodies link related entries as [[id]]; call \`memory\` with action='get' to read any other body together with its linked entries; proactively call \`memory\` to add/update when learning durable conventions, decisions, commands, or gotchas):\n\n`;
	if (entries.length === 0) {
		return `${header}No entries yet.`;
	}

	let used = header.length;
	let indexed = 0;
	for (const entry of entries) {
		const line = formatIndexLine(entry);
		if (used + line.length > charBudget - OMITTED_NOTE_RESERVE) break;
		used += line.length;
		indexed++;
	}

	let rendered = header;
	for (const entry of entries.slice(0, indexed)) {
		rendered += formatIndexLine(entry);
		if (!entry.pinned || !entry.body?.trim()) continue;
		const body = `${entry.body
			.trim()
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n")}\n`;
		if (used + body.length <= charBudget - OMITTED_NOTE_RESERVE) {
			rendered += body;
			used += body.length;
		}
	}
	if (indexed < entries.length) {
		rendered += `\n... ${entries.length - indexed} more entries; use 'memory list' or 'memory search' to inspect.\n`;
	}

	return rendered.trim();
}

export function renderToolCall(args: Record<string, unknown>, theme: Theme): Text {
	let text = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", String(args.action ?? ""));
	if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
	if (args.id) text += ` ${theme.fg("accent", String(args.id))}`;
	if (args.category) text += ` ${theme.fg("dim", `(${args.category})`)}`;
	if (args.query) text += ` ${theme.fg("dim", `query="${args.query}"`)}`;
	return new Text(text, 0, 0);
}

export function renderToolResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const details = result.details as MemoryToolDetails | undefined;
	if (!details) {
		const textItem = result.content[0];
		return new Text(textItem?.type === "text" && textItem.text ? textItem.text : "", 0, 0);
	}

	if (details.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	switch (details.action) {
		case "add": {
			const entry = details.entry;
			if (!entry) return new Text(theme.fg("success", "✓ Added memory"), 0, 0);
			let line =
				theme.fg("success", "✓ Added ") +
				theme.fg("accent", `[${entry.id}]`) +
				" " +
				theme.fg("dim", `(${entry.category})`) +
				" " +
				theme.fg("text", entry.title);
			if (entry.body && options.expanded) {
				line += `\n${theme.fg("dim", entry.body)}`;
			}
			return new Text(line, 0, 0);
		}
		case "update": {
			const entry = details.entry;
			if (!entry) return new Text(theme.fg("success", "✓ Updated memory"), 0, 0);
			return new Text(
				theme.fg("success", "✓ Updated ") +
					theme.fg("accent", `[${entry.id}]`) +
					" " +
					theme.fg("dim", `(${entry.category})`) +
					" " +
					theme.fg("text", entry.title),
				0,
				0,
			);
		}
		case "delete": {
			const id = details.deletedId ?? details.entry?.id ?? "";
			return new Text(
				theme.fg("success", "✓ Deleted ") +
					theme.fg("accent", `[${id}]`) +
					(details.entry ? ` ${theme.fg("dim", details.entry.title)}` : ""),
				0,
				0,
			);
		}
		case "get": {
			const entry = details.entry;
			if (!entry) return new Text(theme.fg("dim", "Entry not found"), 0, 0);
			let output =
				theme.fg("accent", `[${entry.id}]`) +
				" " +
				theme.fg("dim", `(${entry.category}${entry.pinned ? ", pinned" : ""})`) +
				" " +
				theme.bold(entry.title);
			if (entry.body) {
				output += `\n${theme.fg("text", entry.body)}`;
			}
			for (const linked of details.links?.linked ?? []) {
				output += `\n${theme.fg("dim", "-> ")}${theme.fg("accent", `[${linked.id}]`)} ${theme.fg("dim", linked.title)}`;
			}
			for (const linker of details.links?.linkedFrom ?? []) {
				output += `\n${theme.fg("dim", "<- ")}${theme.fg("accent", `[${linker.id}]`)} ${theme.fg("dim", linker.title)}`;
			}
			return new Text(output, 0, 0);
		}
		case "search": {
			const list = details.entries ?? [];
			if (list.length === 0) {
				return new Text(theme.fg("dim", "No matching memories found"), 0, 0);
			}
			let out = theme.fg("muted", `Found ${list.length} match(es):`);
			const display = options.expanded ? list : list.slice(0, 5);
			for (const item of display) {
				out += `\n${theme.fg("accent", `[${item.id}]`)} ${theme.fg("dim", `(${item.category})`)} ${item.title}`;
			}
			if (!options.expanded && list.length > 5) {
				out += `\n${theme.fg("dim", `... ${list.length - 5} more`)}`;
			}
			return new Text(out, 0, 0);
		}
		case "list": {
			const list = details.entries ?? [];
			if (list.length === 0) {
				return new Text(theme.fg("dim", "No memory entries recorded"), 0, 0);
			}
			let out = theme.fg("muted", `${list.length} memory entries:`);
			const display = options.expanded ? list : list.slice(0, 10);
			for (const item of display) {
				const pin = item.pinned ? theme.fg("accent", "★ ") : "  ";
				out += `\n${pin}${theme.fg("accent", `[${item.id}]`)} ${theme.fg("dim", `(${item.category})`)} ${item.title}`;
			}
			if (!options.expanded && list.length > 10) {
				out += `\n${theme.fg("dim", `... ${list.length - 10} more`)}`;
			}
			return new Text(out, 0, 0);
		}
	}
}

export class MemoryListComponent {
	private entries: MemoryEntry[];
	private projectRoot: string;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private onClose: () => void;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		entries: MemoryEntry[],
		projectRoot: string,
		theme: Theme,
		keybindings: KeybindingsManager,
		onClose: () => void,
	) {
		this.entries = entries;
		this.projectRoot = projectRoot;
		this.theme = theme;
		this.keybindings = keybindings;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (
			this.keybindings.matches(data, "tui.select.cancel") ||
			this.keybindings.matches(data, "app.interrupt") ||
			this.keybindings.matches(data, "app.clear")
		) {
			this.onClose();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				this.invalidate();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			this.scrollOffset++;
			this.invalidate();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
			this.invalidate();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollOffset += 10;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Project Memory ");
		const headerLine =
			th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 20)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push(truncateToWidth(`  ${th.fg("dim", `Project: ${this.projectRoot}`)}`, width));
		lines.push("");

		if (this.entries.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No memories recorded yet for this project.")}`, width));
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "Use '/memory add <text>' or ask the agent to remember something.")}`,
					width,
				),
			);
		} else {
			const pinnedCount = this.entries.filter((e) => e.pinned).length;
			lines.push(
				truncateToWidth(`  ${th.fg("muted", `${this.entries.length} entries (${pinnedCount} pinned)`)}`, width),
			);
			lines.push("");

			for (let i = this.scrollOffset; i < this.entries.length; i++) {
				const item = this.entries[i];
				const pin = item.pinned ? th.fg("accent", "★ ") : "  ";
				const idStr = th.fg("accent", `[${item.id}]`);
				const catStr = th.fg("dim", `(${item.category})`);
				const titleStr = th.fg("text", item.title);
				lines.push(truncateToWidth(`  ${pin}${idStr} ${catStr} ${titleStr}`, width));
				if (item.body) {
					const firstBodyLine = item.body.split("\n")[0] ?? "";
					lines.push(truncateToWidth(`      ${th.fg("dim", firstBodyLine)}`, width));
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "↑/↓ Scroll · Esc / Ctrl+C Close · /memory add <text>")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
