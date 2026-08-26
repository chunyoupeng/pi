import * as os from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderContext, ToolRenderResultOptions } from "../extensions/types.ts";
import type { SubagentToolDetails, SubagentToolInput, SubagentUsage } from "../subagent/types.ts";

const COLLAPSED_ITEM_COUNT = 8;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatSubagentUsage(usage?: SubagentUsage, model?: string): string {
	if (!usage) return "";
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatSubagentToolCall(name: string, args: Record<string, unknown>, theme: Theme): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (name) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = theme.fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return theme.fg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return theme.fg("muted", "write ") + theme.fg("accent", shortenPath(rawPath));
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return theme.fg("muted", "edit ") + theme.fg("accent", shortenPath(rawPath));
		}
		case "grep": {
			const pattern = (args.query || args.pattern || "...") as string;
			const preview = pattern.length > 40 ? `${pattern.slice(0, 40)}...` : pattern;
			return theme.fg("muted", "grep ") + theme.fg("toolOutput", `"${preview}"`);
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			return theme.fg("muted", "find ") + theme.fg("toolOutput", pattern);
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return theme.fg("muted", "ls ") + theme.fg("accent", shortenPath(rawPath));
		}
		default: {
			const preview = JSON.stringify(args);
			return (
				theme.fg("muted", `${name} `) +
				theme.fg("dim", preview.length > 40 ? `${preview.slice(0, 40)}...` : preview)
			);
		}
	}
}

/** Display an agent key ("scout", "code-reviewer") as a capitalized label ("Scout", "Code Reviewer"). */
function displayAgentName(name: string): string {
	return name
		.split(/[\s_-]+/)
		.map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
		.join(" ");
}

export function renderSubagentCall(
	args: SubagentToolInput,
	theme: Theme,
	_context: ToolRenderContext<any, SubagentToolInput>,
): Component {
	const agentName = args.agent || "...";
	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	const sessionLabel = args.sessionId ? ` (${args.sessionId}${args.resetSession ? " [reset]" : ""})` : "";
	let text =
		theme.fg("toolTitle", theme.bold("Subagent ")) +
		theme.fg("accent", displayAgentName(agentName)) +
		theme.fg("muted", sessionLabel);
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<any, SubagentToolInput>,
): Component {
	const details = result.details as SubagentToolDetails | undefined;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const isError = context.isError || details.status === "error" || details.status === "aborted";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const steps = details.steps ?? [];
	const sourceLabel = details.source ? theme.fg("muted", ` (${details.source})`) : "";
	const nameLabel = details.name ? theme.fg("accent", ` (${details.name})`) : "";
	const resumedLabel = details.isResumed ? theme.fg("warning", " [resumed]") : "";

	if (options.expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(displayAgentName(details.agent)))}${nameLabel}${resumedLabel}${sourceLabel}`;
		if (details.sessionId) {
			header += ` ${theme.fg("muted", `[${details.sessionId}]`)}`;
		}
		if (isError && details.errorMessage) {
			header += ` ${theme.fg("error", `[${details.status}]`)}`;
		}
		container.addChild(new Text(header, 0, 0));

		if (isError && details.errorMessage) {
			container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", details.task), 0, 0));

		if (steps.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Execution Steps ───"), 0, 0));
			for (const step of steps) {
				container.addChild(
					new Text(`${theme.fg("muted", "→ ")}${formatSubagentToolCall(step.name, step.args, theme)}`, 0, 0),
				);
			}
		}

		if (details.finalText) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			container.addChild(new Markdown(details.finalText.trim(), 0, 0, getMarkdownTheme()));
		}

		const usageStr = formatSubagentUsage(details.usage, details.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}

		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold(displayAgentName(details.agent)))}${nameLabel}${resumedLabel}${sourceLabel}`;
	if (isError && details.errorMessage) {
		text += `\n${theme.fg("error", `Error: ${details.errorMessage}`)}`;
	} else if (steps.length === 0 && !details.finalText) {
		text += `\n${theme.fg("muted", "(no output)")}`;
	} else {
		const toShow = steps.slice(-COLLAPSED_ITEM_COUNT);
		const skipped = steps.length > COLLAPSED_ITEM_COUNT ? steps.length - COLLAPSED_ITEM_COUNT : 0;
		if (skipped > 0) {
			text += `\n${theme.fg("muted", `... ${skipped} earlier steps`)}`;
		}
		for (const step of toShow) {
			text += `\n${theme.fg("muted", "→ ")}${formatSubagentToolCall(step.name, step.args, theme)}`;
		}
		if (steps.length > COLLAPSED_ITEM_COUNT || details.finalText) {
			const key = keyText("app.tools.expand") || "ctrl+o";
			text += `\n${theme.fg("dim", `(${key} to expand)`)}`;
		}
	}

	const usageStr = formatSubagentUsage(details.usage, details.model);
	if (usageStr) {
		text += `\n${theme.fg("dim", usageStr)}`;
	}

	return new Text(text, 0, 0);
}
