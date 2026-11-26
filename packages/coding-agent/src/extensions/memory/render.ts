import type { TextContent } from "@earendil-works/pi-ai";
import { Box, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { MessageRenderOptions } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { CustomMessage } from "../../core/messages.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { MemoryDreamMessageDetails } from "./dream.ts";
import { GLOBAL_CHAR_BUDGET, type MemoryEntry, type MemoryToolDetails, PROJECT_CHAR_BUDGET } from "./types.ts";

function formatIndexLine(entry: MemoryEntry): string {
	return `- [${entry.id}] (${entry.category}${entry.pinned ? ", pinned" : ""}) ${entry.title}\n`;
}

const OMITTED_NOTE_RESERVE = 76;

function renderIndexBlock(header: string, entries: MemoryEntry[], charBudget: number): string {
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

	const bodyBudgetLimit = indexed < entries.length ? charBudget - OMITTED_NOTE_RESERVE : charBudget;
	let rendered = header;
	for (const entry of entries.slice(0, indexed)) {
		rendered += formatIndexLine(entry);
		if (!entry.pinned || !entry.body?.trim()) continue;
		const body = `${entry.body
			.trim()
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n")}\n`;
		if (used + body.length <= bodyBudgetLimit) {
			rendered += body;
			used += body.length;
		}
	}
	if (indexed < entries.length) {
		rendered += `\n... ${entries.length - indexed} more entries; use 'memory list' or 'memory search' to inspect.\n`;
	}

	return rendered.trim();
}

/**
 * Every entry's title goes in first so the model can see what exists and update instead of
 * duplicating; only pinned entries spend the remaining budget on their bodies.
 */
export function renderPromptSection(
	projectRoot: string,
	entries: MemoryEntry[],
	charBudget = PROJECT_CHAR_BUDGET,
	globalEntries: MemoryEntry[] = [],
	globalCharBudget = GLOBAL_CHAR_BUDGET,
): string {
	const projectHeader = `Project: ${projectRoot}\nMemory index (pinned entries include their body; bodies link related entries as [[id]]; call \`memory\` with action='get' to read any other body together with its linked entries; proactively call \`memory\` to add/update when learning durable conventions, decisions, commands, or gotchas):\n\n`;
	const projectSection = renderIndexBlock(projectHeader, entries, charBudget);

	if (globalEntries.length === 0) {
		return projectSection;
	}

	const globalHeader = `Global memory (cross-project, scope="global"):\n`;
	const globalSection = renderIndexBlock(globalHeader, globalEntries, globalCharBudget);
	return `${globalSection}\n\n${projectSection}`;
}

function formatEntryBadges(entry: MemoryEntry, theme: Theme): string {
	let badges = "";
	if (entry.scope === "global") badges += `${theme.fg("warning", "[global]")} `;
	if (entry.archived) badges += `${theme.fg("dim", "[archived]")} `;
	return badges;
}

export function renderToolCall(args: Record<string, unknown>, theme: Theme): Text {
	let text = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", String(args.action ?? ""));
	if (args.scope === "global") text += ` ${theme.fg("warning", "[global]")}`;
	else if (args.scope === "project" || args.scope === "all") text += ` ${theme.fg("dim", `[${args.scope}]`)}`;
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
				formatEntryBadges(entry, theme) +
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
					formatEntryBadges(entry, theme) +
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
			const scopeBadge =
				details.entry?.scope === "global" || details.scope === "global"
					? `${theme.fg("warning", "[global]")} `
					: "";
			const archivedBadge = details.entry?.archived ? `${theme.fg("dim", "[archived]")} ` : "";
			return new Text(
				theme.fg("success", "✓ Deleted ") +
					scopeBadge +
					archivedBadge +
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
				formatEntryBadges(entry, theme) +
				theme.fg("accent", `[${entry.id}]`) +
				" " +
				theme.fg("dim", `(${entry.category}${entry.pinned ? ", pinned" : ""})`) +
				" " +
				theme.bold(entry.title);
			if (entry.body) {
				output += `\n${theme.fg("text", entry.body)}`;
			}
			for (const linked of details.links?.linked ?? []) {
				output += `\n${theme.fg("dim", "-> ")}${formatEntryBadges(linked, theme)}${theme.fg("accent", `[${linked.id}]`)} ${theme.fg("dim", linked.title)}`;
			}
			for (const linker of details.links?.linkedFrom ?? []) {
				output += `\n${theme.fg("dim", "<- ")}${formatEntryBadges(linker, theme)}${theme.fg("accent", `[${linker.id}]`)} ${theme.fg("dim", linker.title)}`;
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
				out += `\n${formatEntryBadges(item, theme)}${theme.fg("accent", `[${item.id}]`)} ${theme.fg("dim", `(${item.category})`)} ${item.title}`;
			}
			if (!options.expanded && list.length > 5) {
				out += `\n${theme.fg("dim", `... ${list.length - 5} more`)}`;
			}
			return new Text(out, 0, 0);
		}
		case "list": {
			const list = details.entries ?? [];
			const archivedSuffix =
				details.archivedCount && details.archivedCount > 0 ? ` (${details.archivedCount} archived)` : "";
			if (list.length === 0) {
				return new Text(theme.fg("dim", `No active memory entries recorded${archivedSuffix}`), 0, 0);
			}
			let out = theme.fg("muted", `${list.length} memory entries${archivedSuffix}:`);
			const display = options.expanded ? list : list.slice(0, 10);
			for (const item of display) {
				const pin = item.pinned ? theme.fg("accent", "★ ") : "  ";
				out += `\n${pin}${formatEntryBadges(item, theme)}${theme.fg("accent", `[${item.id}]`)} ${theme.fg("dim", `(${item.category})`)} ${item.title}`;
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
	private globalEntries: MemoryEntry[];
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
		globalEntries: MemoryEntry[] = [],
	) {
		this.entries = entries;
		this.globalEntries = globalEntries;
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
		const hasGlobal = this.globalEntries.length > 0;

		lines.push("");
		const titleLabel = hasGlobal ? " Memory (Global + Project) " : " Project Memory ";
		const title = th.fg("accent", titleLabel);
		const headerLine =
			th.fg("borderMuted", "───") +
			title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - titleLabel.length - 4)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push(truncateToWidth(`  ${th.fg("dim", `Project: ${this.projectRoot}`)}`, width));
		lines.push("");

		const bodyLines: string[] = [];
		const pushEntryLines = (items: MemoryEntry[]): void => {
			for (const item of items) {
				const pin = item.pinned ? th.fg("accent", "★ ") : "  ";
				const badges = formatEntryBadges(item, th);
				const idStr = th.fg("accent", `[${item.id}]`);
				const catStr = th.fg("dim", `(${item.category})`);
				const titleStr = th.fg("text", item.title);
				bodyLines.push(truncateToWidth(`  ${pin}${badges}${idStr} ${catStr} ${titleStr}`, width));
				if (item.body) {
					const firstBodyLine = item.body.split("\n")[0] ?? "";
					bodyLines.push(truncateToWidth(`      ${th.fg("dim", firstBodyLine)}`, width));
				}
			}
		};

		if (hasGlobal) {
			const globalPinned = this.globalEntries.filter((e) => e.pinned).length;
			bodyLines.push(
				truncateToWidth(
					`  ${th.fg("warning", "Global Memory")} ${th.fg("muted", `(${this.globalEntries.length} entries, ${globalPinned} pinned)`)}`,
					width,
				),
			);
			pushEntryLines(this.globalEntries);
			bodyLines.push("");
		}

		if (hasGlobal) {
			const projectPinned = this.entries.filter((e) => e.pinned).length;
			bodyLines.push(
				truncateToWidth(
					`  ${th.fg("accent", "Project Memory")} ${th.fg("muted", `(${this.entries.length} entries, ${projectPinned} pinned)`)}`,
					width,
				),
			);
		}

		if (this.entries.length === 0) {
			bodyLines.push(truncateToWidth(`  ${th.fg("dim", "No memories recorded yet for this project.")}`, width));
			if (!hasGlobal) {
				bodyLines.push(
					truncateToWidth(
						`  ${th.fg("dim", "Use '/memory add <text>' or ask the agent to remember something.")}`,
						width,
					),
				);
			}
		} else {
			if (!hasGlobal) {
				const pinnedCount = this.entries.filter((e) => e.pinned).length;
				bodyLines.push(
					truncateToWidth(`  ${th.fg("muted", `${this.entries.length} entries (${pinnedCount} pinned)`)}`, width),
				);
				bodyLines.push("");
			}
			pushEntryLines(this.entries);
		}

		const clampedOffset = Math.min(this.scrollOffset, Math.max(0, bodyLines.length - 1));
		for (let i = clampedOffset; i < bodyLines.length; i++) {
			lines.push(bodyLines[i]);
		}

		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("dim", "↑/↓ Scroll · Esc / Ctrl+C Close · /memory add <text> · /memory global add <text>")}`,
				width,
			),
		);
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

/** Compact banner shown in the transcript when a dream consolidation turn is triggered. */
export function renderDreamMessage(
	message: CustomMessage<MemoryDreamMessageDetails>,
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const details = message.details;
	if (!details) return undefined;

	const metaParts: string[] = [details.trigger];
	if (details.decayedCount > 0) metaParts.push(`decayed ${details.decayedCount}`);
	if (details.brokenLinkCount > 0) metaParts.push(`${details.brokenLinkCount} broken link(s)`);

	const summaryLine =
		`${theme.fg("accent", theme.bold("memory dream"))} ` +
		`${theme.fg("dim", `(${metaParts.join(" · ")})`)} ` +
		`${theme.fg("muted", "consolidating session memories")}`;

	const lines = [summaryLine];
	if (options.expanded) {
		const rawText =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part): part is TextContent => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		lines.push("", theme.fg("dim", rawText));
	}

	const bgFn = typeof theme.bg === "function" ? (t: string) => theme.bg("customMessageBg", t) : undefined;
	const box = new Box(options.outputPad, 0, bgFn);
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
}
