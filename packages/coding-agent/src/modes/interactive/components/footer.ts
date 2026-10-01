import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";

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

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
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
	private sessionStats?: SessionStats;

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

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
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
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			latestCacheHitRate,
			contextUsage,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercentKnown = contextUsage?.percent !== null;
		const sep = theme.fg("dim", "  ·  ");

		// Location: cwd, git branch, session name
		const rawPwd = formatCwdForFooter(
			this.session.sessionManager.getCwd(),
			process.env.HOME || process.env.USERPROFILE,
		);
		let location = theme.fg("muted", rawPwd);
		const branch = this.footerData.getGitBranch();
		if (branch) {
			location += ` ${theme.fg("dim", "(")}${theme.fg("accent", branch)}${theme.fg("dim", ")")}`;
		}
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			location += ` ${theme.fg("dim", "•")} ${theme.fg("text", sessionName)}`;
		}

		// Model: provider / model · thinking → routed
		const modelName = state.model?.id || "no-model";
		let modelBlock = theme.fg("text", modelName);
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			const thinkingColor = theme.getThinkingBorderColor(thinkingLevel);
			const label = thinkingLevel === "off" ? "thinking off" : thinkingLevel;
			modelBlock += ` ${theme.fg("dim", "·")} ${thinkingColor(label)}`;
		}
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			modelBlock = `${theme.fg("dim", `${state.model.provider} / `)}${modelBlock}`;
		}
		const routed = this.session.routedModel;
		if (routed) {
			modelBlock += ` → ${routed.model.id}${routed.thinkingLevel ? ` · ${routed.thinkingLevel}` : ""}`;
		}

		// Traffic: cumulative input/output tokens. Grows during streaming, so it lives on the
		// left where growth only consumes blank space instead of shifting the right block.
		const trafficParts: string[] = [];
		if (usageTotals.input) {
			trafficParts.push(`${theme.fg("dim", "↑")} ${theme.fg("muted", formatTokens(usageTotals.input))}`);
		}
		const outputTotal = usageTotals.output + this.liveOutputTokens;
		if (outputTotal) {
			trafficParts.push(`${theme.fg("dim", "↓")} ${theme.fg("muted", formatTokens(outputTotal))}`);
		}
		const trafficBlock = trafficParts.join("  ");

		let cacheBlock = "";
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
			cacheBlock = c.trim();
		}

		// Context: gauge + percent, window size and auto-compaction state as dim trailers
		const gaugeColor: ThemeColor =
			contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "syntaxType";
		let contextBlock = "";
		if (contextWindow > 0) {
			const totalBlocks = 6;
			const filled =
				contextPercentValue > 0
					? Math.max(1, Math.min(totalBlocks, Math.round((contextPercentValue / 100) * totalBlocks)))
					: 0;
			contextBlock = `${theme.fg(gaugeColor, "▰".repeat(filled))}${theme.fg("borderMuted", "▱".repeat(totalBlocks - filled))} `;
		}
		const pctText = contextPercentKnown ? `${contextPercentValue.toFixed(1)}%` : "?";
		contextBlock += theme.fg(gaugeColor === "syntaxType" ? "text" : gaugeColor, pctText);
		if (contextWindow > 0) {
			contextBlock += ` ${theme.fg("dim", `· ${formatTokens(contextWindow)}`)}`;
		}
		if (!this.autoCompactEnabled) {
			contextBlock += ` ${theme.fg("dim", "· no-auto")}`;
		}
		if (areExperimentalFeaturesEnabled()) {
			contextBlock += ` ${theme.fg("dim", "·")} ${theme.bold(theme.fg("warning", "xp"))}`;
		}

		let costBlock = "";
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			costBlock = theme.fg("text", `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}

		const minPadding = 2;
		const joinEnds = (left: string, right: string): string | undefined => {
			const leftW = visibleWidth(left);
			const rightW = visibleWidth(right);
			if (leftW + minPadding + rightW > width) return undefined;
			return left + " ".repeat(width - leftW - rightW) + right;
		};
		const nonEmpty = (parts: string[]) => parts.filter((s) => s.length > 0);

		// Preferred layout: one line. Location and traffic left, model and context right.
		const lines: string[] = [];
		const oneLine = joinEnds(
			nonEmpty([location, trafficBlock, cacheBlock]).join(sep),
			nonEmpty([modelBlock, contextBlock, costBlock]).join(sep),
		);
		if (oneLine !== undefined) {
			lines.push(oneLine);
		} else {
			lines.push(
				this.renderTwoEnded(width, location, modelBlock),
				this.renderStatsLine(width, trafficBlock, cacheBlock, contextBlock, costBlock),
			);
		}

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

	/** Location left, model right; truncates whichever side has room to give. */
	private renderTwoEnded(width: number, leftSide: string, rightSide: string): string {
		const minPadding = 2;
		const leftW = visibleWidth(leftSide);
		const rightW = visibleWidth(rightSide);
		if (leftW + minPadding + rightW <= width) {
			return leftSide + " ".repeat(width - leftW - rightW) + rightSide;
		}
		if (width - rightW - minPadding >= 12) {
			const truncLeft = truncateToWidth(leftSide, width - rightW - minPadding, theme.fg("dim", "..."));
			return truncLeft + " ".repeat(Math.max(1, width - visibleWidth(truncLeft) - rightW)) + rightSide;
		}
		if (width - leftW - minPadding >= 10) {
			const truncRight = truncateToWidth(rightSide, width - leftW - minPadding, "");
			return leftSide + " ".repeat(Math.max(1, width - leftW - visibleWidth(truncRight))) + truncRight;
		}
		return truncateToWidth(leftSide, width, theme.fg("dim", "..."));
	}

	/** Traffic and cache left, context and cost right; drops cache, then traffic, then truncates. */
	private renderStatsLine(
		width: number,
		trafficBlock: string,
		cacheBlock: string,
		contextBlock: string,
		costBlock: string,
	): string {
		const minPadding = 2;
		const sep = theme.fg("dim", "  ·  ");
		const right = [contextBlock, costBlock].filter((s) => s.length > 0).join(sep);
		const rightW = visibleWidth(right);
		for (const left of [[trafficBlock, cacheBlock].filter((s) => s.length > 0).join(sep), trafficBlock]) {
			const leftW = visibleWidth(left);
			if (leftW + minPadding + rightW <= width) {
				return left + " ".repeat(width - leftW - rightW) + right;
			}
		}
		if (rightW <= width) {
			return " ".repeat(width - rightW) + right;
		}
		return truncateToWidth(right, width, theme.fg("dim", "..."));
	}
}
