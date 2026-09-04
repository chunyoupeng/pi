import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, type Focusable, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { estimateTokens } from "../../../core/compaction/index.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";

export interface ContextItemDetail {
	label: string;
	tokens?: number;
	description?: string;
}

export interface ContextCategory {
	id: string;
	name: string;
	color: ThemeColor;
	tokens: number;
	percentage: number;
	summary: string;
	details: ContextItemDetail[];
}

export interface ContextData {
	modelName: string;
	provider: string;
	contextWindow: number;
	totalTokens: number;
	percentOfWindow: number;
	categories: ContextCategory[];
}

function extractMessagePreview(message: AgentMessage): string {
	switch (message.role) {
		case "user": {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter(
						(b: unknown) =>
							typeof b === "object" && b !== null && "type" in b && (b as { type: string }).type === "text",
					)
					.map((b: unknown) => (b as { text?: string }).text ?? "")
					.join(" ");
			}
			return "";
		}
		case "assistant": {
			const content = (message as { content?: unknown }).content;
			if (Array.isArray(content)) {
				return content
					.filter(
						(b: unknown) =>
							typeof b === "object" && b !== null && "type" in b && (b as { type: string }).type === "text",
					)
					.map((b: unknown) => (b as { text?: string }).text ?? "")
					.join(" ");
			}
			return "";
		}
		case "bashExecution": {
			const bash = message as { command?: string; output?: string };
			return `$ ${bash.command ?? ""}: ${bash.output ?? ""}`;
		}
		case "toolResult": {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter(
						(b: unknown) =>
							typeof b === "object" && b !== null && "type" in b && (b as { type: string }).type === "text",
					)
					.map((b: unknown) => (b as { text?: string }).text ?? "")
					.join(" ");
			}
			return "";
		}
		case "branchSummary":
		case "compactionSummary": {
			return (message as { summary?: string }).summary ?? "";
		}
		default:
			return "";
	}
}

export function buildContextBreakdown(session: AgentSession): ContextData {
	const model = session.model;
	const modelName = model?.name ?? model?.id ?? "unknown";
	const provider = model?.provider ?? "unknown";
	const contextWindow = model?.contextWindow ?? 0;

	// 1. System Prompt breakdown
	const systemPrompt = session.systemPrompt ?? "";
	let skillsPromptTokens = 0;
	let projectContextTokens = 0;

	const skillsMatch = systemPrompt.match(/<available_skills>([\s\S]*?)<\/available_skills>/);
	if (skillsMatch) {
		skillsPromptTokens = Math.ceil(skillsMatch[0].length / 4);
	}

	const projectContextMatch = systemPrompt.match(/<project_context>([\s\S]*?)<\/project_context>/);
	if (projectContextMatch) {
		projectContextTokens = Math.ceil(projectContextMatch[0].length / 4);
	}

	const fullSystemPromptTokens = Math.ceil(systemPrompt.length / 4);
	const baseInstructionsTokens = Math.max(0, fullSystemPromptTokens - skillsPromptTokens - projectContextTokens);
	const systemPromptCategoryTokens = baseInstructionsTokens + projectContextTokens;

	const systemPromptDetails: ContextItemDetail[] = [
		{
			label: "Base Instructions",
			tokens: baseInstructionsTokens,
			description: "Agent instructions & core guidelines",
		},
	];
	if (projectContextTokens > 0) {
		const instructionFiles = [...systemPrompt.matchAll(/<project_instructions path="([^"]+)">/g)].map(
			(m) => m[1]?.split("/").pop() ?? m[1] ?? "instructions",
		);
		systemPromptDetails.push({
			label: "Project Context",
			tokens: projectContextTokens,
			description: instructionFiles.length > 0 ? instructionFiles.join(", ") : "Project context & guidelines",
		});
	}

	// 2. Skills
	const loadedSkills = session.resourceLoader?.getSkills?.()?.skills ?? [];
	const skillsDetails: ContextItemDetail[] = loadedSkills.map((s) => ({
		label: s.name,
		tokens: Math.ceil(((s.description?.length ?? 0) + s.name.length) / 4),
		description: s.description,
	}));
	const skillsTokens =
		skillsPromptTokens > 0
			? skillsPromptTokens
			: loadedSkills.reduce((sum, s) => sum + Math.ceil(((s.description?.length ?? 0) + s.name.length + 50) / 4), 0);

	// 3. Tools
	const tools = session.state?.tools ?? [];
	let toolsTokens = 0;
	const toolDetails: ContextItemDetail[] = [];
	for (const tool of tools) {
		const schemaStr = JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		});
		const toolEst = Math.ceil(schemaStr.length / 4);
		toolsTokens += toolEst;
		toolDetails.push({
			label: tool.name,
			tokens: toolEst,
			description: tool.description,
		});
	}

	// 4. Messages
	const messages = session.messages ?? [];
	const userMessages = messages.filter((m) => m.role === "user");
	const assistantMessages = messages.filter((m) => m.role === "assistant");
	const toolResultMessages = messages.filter((m) => m.role === "toolResult" || m.role === "bashExecution");
	const otherMessages = messages.filter(
		(m) => m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult" && m.role !== "bashExecution",
	);

	const userTokens = userMessages.reduce((sum, m) => sum + estimateTokens(m), 0);
	const assistantTokens = assistantMessages.reduce((sum, m) => sum + estimateTokens(m), 0);
	const toolResultTokens = toolResultMessages.reduce((sum, m) => sum + estimateTokens(m), 0);
	const otherTokens = otherMessages.reduce((sum, m) => sum + estimateTokens(m), 0);

	// User details
	const userDetails: ContextItemDetail[] = userMessages.slice(-5).map((m, idx) => {
		const preview = extractMessagePreview(m)
			.replace(/[\r\n\t]+/g, " ")
			.trim();
		const turnNum = Math.max(1, userMessages.length - 5 + idx + 1);
		return {
			label: `Turn #${turnNum}`,
			tokens: estimateTokens(m),
			description: preview.length > 50 ? `${preview.slice(0, 50)}...` : preview,
		};
	});

	// Assistant details
	let assistantTextTokens = 0;
	let assistantThinkingTokens = 0;
	let assistantToolCalls = 0;
	for (const m of assistantMessages) {
		if (m.role === "assistant" && "content" in m && Array.isArray(m.content)) {
			for (const block of m.content) {
				if (block.type === "text" && block.text) {
					assistantTextTokens += Math.ceil(block.text.length / 4);
				} else if (block.type === "thinking" && block.thinking) {
					assistantThinkingTokens += Math.ceil(block.thinking.length / 4);
				} else if (block.type === "toolCall") {
					assistantToolCalls++;
				}
			}
		}
	}
	const assistantDetails: ContextItemDetail[] = [
		{ label: "Text output", tokens: assistantTextTokens },
		...(assistantThinkingTokens > 0 ? [{ label: "Reasoning / Thinking", tokens: assistantThinkingTokens }] : []),
		...(assistantToolCalls > 0
			? [{ label: "Tool invocations", description: `${assistantToolCalls} tool calls executed` }]
			: []),
	];

	// Tool Result details
	const toolResultDetails: ContextItemDetail[] = toolResultMessages.slice(-5).map((m) => {
		let name = "result";
		let preview = "";
		if (m.role === "bashExecution") {
			const bash = m as { command?: string; output?: string };
			name = `bash: ${bash.command?.slice(0, 25) ?? ""}`;
			preview =
				bash.output
					?.replace(/[\r\n\t]+/g, " ")
					.trim()
					.slice(0, 45) ?? "";
		} else if (m.role === "toolResult") {
			const toolResult = m as { toolCallId?: string; content?: unknown };
			name = `tool: ${toolResult.toolCallId?.slice(0, 10) ?? "call"}`;
			if (typeof toolResult.content === "string") {
				preview = toolResult.content
					.replace(/[\r\n\t]+/g, " ")
					.trim()
					.slice(0, 45);
			} else if (Array.isArray(toolResult.content)) {
				const textPart = toolResult.content.find(
					(c: unknown) => typeof c === "object" && c !== null && "text" in c,
				);
				if (textPart && typeof (textPart as { text?: string }).text === "string") {
					preview = (textPart as { text: string }).text
						.replace(/[\r\n\t]+/g, " ")
						.trim()
						.slice(0, 45);
				}
			}
		}
		return {
			label: name,
			tokens: estimateTokens(m),
			description: preview ? `"${preview}"` : undefined,
		};
	});

	// Totals
	const calculatedTotal =
		systemPromptCategoryTokens +
		skillsTokens +
		toolsTokens +
		userTokens +
		assistantTokens +
		toolResultTokens +
		otherTokens;

	const contextUsage = session.getContextUsage?.();
	const totalTokens =
		contextUsage?.tokens !== null && contextUsage?.tokens !== undefined && contextUsage.tokens > 0
			? contextUsage.tokens
			: calculatedTotal;

	const effectiveWindow = contextWindow > 0 ? contextWindow : 200000;
	const percentOfWindow = effectiveWindow > 0 ? (totalTokens / effectiveWindow) * 100 : 0;

	const categories: ContextCategory[] = [
		{
			id: "system",
			name: "System Prompt",
			color: "syntaxType",
			tokens: systemPromptCategoryTokens,
			percentage: totalTokens > 0 ? (systemPromptCategoryTokens / totalTokens) * 100 : 0,
			summary: `${baseInstructionsTokens.toLocaleString()} base${projectContextTokens > 0 ? ` + ${projectContextTokens.toLocaleString()} context files` : ""}`,
			details: systemPromptDetails,
		},
		{
			id: "skills",
			name: "Skills",
			color: "syntaxVariable",
			tokens: skillsTokens,
			percentage: totalTokens > 0 ? (skillsTokens / totalTokens) * 100 : 0,
			summary: `${loadedSkills.length} loaded (${skillsTokens.toLocaleString()} prompt tokens)`,
			details: skillsDetails.length > 0 ? skillsDetails : [{ label: "(none)", description: "No skills loaded" }],
		},
		{
			id: "tools",
			name: "Tools",
			color: "customMessageLabel",
			tokens: toolsTokens,
			percentage: totalTokens > 0 ? (toolsTokens / totalTokens) * 100 : 0,
			summary: `${tools.length} active (${toolsTokens.toLocaleString()} schema tokens)`,
			details: toolDetails.length > 0 ? toolDetails : [{ label: "(none)", description: "No tools configured" }],
		},
		{
			id: "user",
			name: "User Messages",
			color: "success",
			tokens: userTokens,
			percentage: totalTokens > 0 ? (userTokens / totalTokens) * 100 : 0,
			summary: `${userMessages.length} message${userMessages.length === 1 ? "" : "s"} (${userTokens.toLocaleString()} tokens)`,
			details: userDetails.length > 0 ? userDetails : [{ label: "(none)", description: "No user messages" }],
		},
		{
			id: "assistant",
			name: "Assistant",
			color: "warning",
			tokens: assistantTokens,
			percentage: totalTokens > 0 ? (assistantTokens / totalTokens) * 100 : 0,
			summary: `${assistantMessages.length} response${assistantMessages.length === 1 ? "" : "s"} (${assistantTokens.toLocaleString()} tokens)`,
			details:
				assistantDetails.length > 0 ? assistantDetails : [{ label: "(none)", description: "No responses yet" }],
		},
		{
			id: "toolResults",
			name: "Tool Results",
			color: "syntaxString",
			tokens: toolResultTokens,
			percentage: totalTokens > 0 ? (toolResultTokens / totalTokens) * 100 : 0,
			summary: `${toolResultMessages.length} result${toolResultMessages.length === 1 ? "" : "s"} (${toolResultTokens.toLocaleString()} tokens)`,
			details:
				toolResultDetails.length > 0
					? toolResultDetails
					: [{ label: "(none)", description: "No tool results yet" }],
		},
	];

	if (otherTokens > 0) {
		categories.push({
			id: "other",
			name: "Other Context",
			color: "muted",
			tokens: otherTokens,
			percentage: totalTokens > 0 ? (otherTokens / totalTokens) * 100 : 0,
			summary: `${otherMessages.length} item${otherMessages.length === 1 ? "" : "s"} (${otherTokens.toLocaleString()} tokens)`,
			details: otherMessages.slice(-3).map((m, i) => ({
				label: `#${i + 1} (${m.role})`,
				tokens: estimateTokens(m),
			})),
		});
	}

	return {
		modelName,
		provider,
		contextWindow,
		totalTokens,
		percentOfWindow,
		categories,
	};
}

/**
 * Context usage inspector panel displayed at the bottom of the screen.
 * Shows breakdown of system prompt, tools, skills, user messages, assistant responses, and tool results,
 * each color-coded with interactive category navigation.
 */
export class ContextPanelComponent implements Component, Focusable {
	private data: ContextData;
	private selectedIndex: number;
	public onClose: () => void;
	private _focused: boolean;
	private terminalHeight?: number;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(sessionOrData: AgentSession | ContextData, onClose: () => void, terminalHeight?: number) {
		this.selectedIndex = 0;
		this._focused = true;
		this.onClose = onClose;
		this.terminalHeight = terminalHeight;
		if ("categories" in sessionOrData) {
			this.data = sessionOrData;
		} else {
			this.data = buildContextBreakdown(sessionOrData);
		}
	}

	invalidate(): void {}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (
			kb.matches(keyData, "tui.select.cancel") ||
			kb.matches(keyData, "tui.select.confirm") ||
			keyData === "q" ||
			keyData === "Q"
		) {
			this.onClose();
			return;
		}

		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex <= 0 ? this.data.categories.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex >= this.data.categories.length - 1 ? 0 : this.selectedIndex + 1;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const hr = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));

		lines.push(hr);

		// Header line: title + model info
		const title = theme.bold("Context Usage");
		const modelInfo = theme.fg("dim", `${this.data.modelName} (${this.data.provider})`);
		lines.push(truncateToWidth(`  ${title}  ${modelInfo}`, width));

		// Token usage summary
		const usedTokens = this.data.totalTokens.toLocaleString();
		const windowTokens = (this.data.contextWindow > 0 ? this.data.contextWindow : 200000).toLocaleString();
		const pct = this.data.percentOfWindow.toFixed(1);
		const freeTokens = Math.max(
			0,
			(this.data.contextWindow > 0 ? this.data.contextWindow : 200000) - this.data.totalTokens,
		).toLocaleString();
		const stats = `  ${theme.fg("text", `${usedTokens} / ${windowTokens} tokens`)} ${theme.fg("dim", `(${pct}%)`)}  •  ${theme.fg("dim", `Free: ${freeTokens} tokens`)}`;
		lines.push(truncateToWidth(stats, width));

		// Progress bar
		const bar = this.renderBar(width);
		if (bar) {
			lines.push("");
			lines.push(truncateToWidth(bar, width));
		}

		lines.push("");

		const isCompact = (this.terminalHeight ?? 24) < 20;
		const maxDetails = isCompact ? 3 : 5;

		// Categories
		for (let i = 0; i < this.data.categories.length; i++) {
			const cat = this.data.categories[i];
			const isSelected = i === this.selectedIndex;
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const bullet = theme.fg(cat.color, "● ");
			const nameStr = isSelected
				? theme.bold(theme.fg(cat.color, cat.name.padEnd(16)))
				: theme.fg(cat.color, cat.name.padEnd(16));
			const tokensStr = `${cat.tokens.toLocaleString().padStart(7)} tokens`;
			const pctStr = theme.fg("dim", `(${cat.percentage.toFixed(1).padStart(5)}%)`);
			const summary = theme.fg("dim", cat.summary);

			lines.push(truncateToWidth(`${cursor}${bullet}${nameStr}  ${tokensStr} ${pctStr}  ${summary}`, width));

			// Details for selected category
			if (isSelected && cat.details.length > 0) {
				const visibleDetails = cat.details.slice(0, maxDetails);
				for (let d = 0; d < visibleDetails.length; d++) {
					const detail = visibleDetails[d];
					const isLast = d === visibleDetails.length - 1 && cat.details.length <= maxDetails;
					const branch = theme.fg("dim", isLast ? "    └─ " : "    ├─ ");
					const label = theme.fg("text", detail.label);
					const tok =
						detail.tokens !== undefined ? theme.fg("dim", `~${detail.tokens.toLocaleString()} tokens`) : "";
					const desc = detail.description ? theme.fg("muted", detail.description) : "";
					lines.push(
						truncateToWidth(`${branch}${label}${tok ? `  ${tok}` : ""}${desc ? `  ${desc}` : ""}`, width),
					);
				}
				if (cat.details.length > maxDetails) {
					const remaining = cat.details.length - maxDetails;
					lines.push(truncateToWidth(theme.fg("dim", `    └─ ... and ${remaining} more`), width));
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(theme.fg("dim", "  ↑/↓ Navigate  •  Esc / Enter Close"), width));
		lines.push(hr);

		return lines;
	}

	private renderBar(width: number): string {
		const barWidth = Math.max(16, Math.min(width - 6, 60));
		const contextWindow = this.data.contextWindow > 0 ? this.data.contextWindow : 200000;
		let remainingBlocks = barWidth;
		const segments: string[] = [];

		for (const cat of this.data.categories) {
			if (cat.tokens <= 0 || remainingBlocks <= 0) continue;
			let blocks = Math.round((cat.tokens / contextWindow) * barWidth);
			if (blocks === 0 && remainingBlocks > 0) {
				blocks = 1;
			}
			blocks = Math.min(blocks, remainingBlocks);
			if (blocks > 0) {
				segments.push(theme.fg(cat.color, "█".repeat(blocks)));
				remainingBlocks -= blocks;
			}
		}

		if (remainingBlocks > 0) {
			segments.push(theme.fg("borderMuted", "░".repeat(remainingBlocks)));
		}

		return `  [${segments.join("")}]`;
	}

	getData(): ContextData {
		return this.data;
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}
}
