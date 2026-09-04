import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	/** Live output tokens from the in-flight assistant turn (not yet persisted). */
	private liveOutputTokens = 0;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/** Set live output tokens for the current streaming turn (0 when idle). */
	setLiveOutputTokens(tokens: number): void {
		this.liveOutputTokens = Math.max(0, Math.floor(tokens));
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		const rawPwd = formatCwdForFooter(
			this.session.sessionManager.getCwd(),
			process.env.HOME || process.env.USERPROFILE,
		);
		let leftSide = theme.fg("muted", rawPwd);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			leftSide += ` ${theme.fg("dim", "(")}${theme.fg("accent", branch)}${theme.fg("dim", ")")}`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			leftSide += ` ${theme.fg("dim", "•")} ${theme.fg("text", sessionName)}`;
		}

		// Build right side for Line 1: model name + provider + thinking level
		const modelName = state.model?.id || "no-model";
		let rightSide = theme.fg("text", modelName);

		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			const thinkingColor = theme.getThinkingBorderColor(thinkingLevel);
			const label = thinkingLevel === "off" ? "thinking off" : thinkingLevel;
			rightSide += ` ${theme.fg("dim", "·")} ${thinkingColor(label)}`;
		}

		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `${theme.fg("dim", `${state.model.provider} / `)}${rightSide}`;
		}

		// Assemble Line 1 with left and right sides
		const minPadding = 2;
		const leftW = visibleWidth(leftSide);
		const rightW = visibleWidth(rightSide);
		let line1: string;

		if (leftW + minPadding + rightW <= width) {
			const pad = " ".repeat(width - leftW - rightW);
			line1 = leftSide + pad + rightSide;
		} else if (width - rightW - minPadding >= 12) {
			const availLeft = width - rightW - minPadding;
			const truncLeft = truncateToWidth(leftSide, availLeft, theme.fg("dim", "..."));
			const pad = " ".repeat(Math.max(1, width - visibleWidth(truncLeft) - rightW));
			line1 = truncLeft + pad + rightSide;
		} else if (width - leftW - minPadding >= 10) {
			const availRight = width - leftW - minPadding;
			const truncRight = truncateToWidth(rightSide, availRight, "");
			const pad = " ".repeat(Math.max(1, width - leftW - visibleWidth(truncRight)));
			line1 = leftSide + pad + truncRight;
		} else {
			line1 = truncateToWidth(leftSide, width, theme.fg("dim", "..."));
		}

		// Build Line 2: Telemetry / Metrics (Balanced two-tier layout)
		// Left side: Traffic & Cache
		const trafficParts: string[] = [];
		if (usageTotals.input) {
			trafficParts.push(`${theme.fg("syntaxVariable", "↑")}${formatTokens(usageTotals.input)}`);
		}
		const outputTotal = usageTotals.output + this.liveOutputTokens;
		if (outputTotal) {
			trafficParts.push(`${theme.fg("syntaxString", "↓")}${formatTokens(outputTotal)}`);
		}
		const trafficStr = trafficParts.join("  ");

		let cacheStr = "";
		if (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) {
			const hitRateStr = latestCacheHitRate !== undefined ? ` (${latestCacheHitRate.toFixed(1)}%)` : "";
			let c = "";
			if (usageTotals.cacheRead > 0) {
				c = `${theme.fg("warning", "⚡")} ${formatTokens(usageTotals.cacheRead)}${hitRateStr}`;
			}
			if (usageTotals.cacheWrite > 0) {
				const writeStr = `+${formatTokens(usageTotals.cacheWrite)}W`;
				c = c ? `${c} ${theme.fg("dim", writeStr)}` : theme.fg("dim", writeStr);
			}
			cacheStr = c.trim();
		}

		const line2LeftParts = [trafficStr, cacheStr].filter((s) => s.length > 0);
		const line2Left = line2LeftParts.join(theme.fg("dim", "  ·  "));

		// Right side: Mini progress bar + Context watermark + Cost
		let miniBar = "";
		if (contextWindow > 0) {
			const totalBlocks = 8;
			let filled = 0;
			if (contextPercentValue > 0) {
				filled = Math.max(1, Math.min(totalBlocks, Math.round((contextPercentValue / 100) * totalBlocks)));
			}
			const empty = totalBlocks - filled;
			const fillChar = "■";
			const emptyChar = "□";
			let fillColored: string;
			if (contextPercentValue > 90) {
				fillColored = theme.fg("error", fillChar.repeat(filled));
			} else if (contextPercentValue > 70) {
				fillColored = theme.fg("warning", fillChar.repeat(filled));
			} else {
				fillColored = theme.fg("syntaxType", fillChar.repeat(filled));
			}
			const emptyColored = theme.fg("borderMuted", emptyChar.repeat(empty));
			miniBar = `${theme.fg("dim", "[")}${fillColored}${emptyColored}${theme.fg("dim", "]")}`;
		}

		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const pctText = contextPercent === "?" ? "?" : `${contextPercent}%`;
		const windowText = `of ${formatTokens(contextWindow)}${autoIndicator}`;
		let contextText = `${pctText} ${windowText}`;

		if (contextPercentValue > 90) {
			contextText = theme.fg("error", contextText);
		} else if (contextPercentValue > 70) {
			contextText = theme.fg("warning", contextText);
		} else {
			contextText = theme.fg("text", contextText);
		}
		if (areExperimentalFeaturesEnabled()) {
			contextText += ` ${theme.fg("dim", "·")} ${theme.bold(theme.fg("warning", "xp"))}`;
		}

		let costBlock = "";
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			costBlock = theme.fg("text", `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}

		const rightElements = [`${miniBar ? `${miniBar} ` : ""}${contextText}`, costBlock].filter((s) => s.length > 0);
		const line2Right = rightElements.join(theme.fg("dim", "  ·  "));

		// Assemble Line 2 with two-ended alignment and responsive degradation
		const l2LeftW = visibleWidth(line2Left);
		const l2RightW = visibleWidth(line2Right);
		let line2: string;

		if (l2LeftW + minPadding + l2RightW <= width) {
			const pad = " ".repeat(width - l2LeftW - l2RightW);
			line2 = line2Left + pad + line2Right;
		} else {
			// Step 1: Drop miniBar to save space
			const rightWithoutBar = [contextText, costBlock].filter((s) => s.length > 0).join(theme.fg("dim", "  ·  "));
			const rNoBarW = visibleWidth(rightWithoutBar);

			if (l2LeftW + minPadding + rNoBarW <= width) {
				const pad = " ".repeat(width - l2LeftW - rNoBarW);
				line2 = line2Left + pad + rightWithoutBar;
			} else {
				// Step 2: Drop cache from left side
				const leftTrafficOnly = trafficStr;
				const lTrafficW = visibleWidth(leftTrafficOnly);

				if (lTrafficW + minPadding + rNoBarW <= width) {
					const pad = " ".repeat(width - lTrafficW - rNoBarW);
					line2 = leftTrafficOnly + pad + rightWithoutBar;
				} else if (rNoBarW <= width) {
					// Step 3: Right side only, right aligned
					const pad = " ".repeat(width - rNoBarW);
					line2 = pad + rightWithoutBar;
				} else {
					// Step 4: Truncate right side
					line2 = truncateToWidth(rightWithoutBar, width, theme.fg("dim", "..."));
				}
			}
		}

		const lines = [line1, line2];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
