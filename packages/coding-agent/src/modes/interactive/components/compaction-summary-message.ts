import { Box, type Component, Markdown, type MarkdownTheme, MouseRegion, rgbColor, Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { Gutter } from "./gutter.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Styled after Claude Code transcripts using a white status bullet gutter
 * without a full-width background block.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super(outputPad, 0);
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	/** Rough estimate of what the context shrank to, based on the summary length. */
	private estimateTokensAfter(): number {
		return Math.ceil(this.message.summary.length / 4);
	}

	private updateDisplay(): void {
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const tokenDetail =
			this.message.tokensBefore > 0 ? `${tokenStr} → ~${this.estimateTokensAfter().toLocaleString()} tokens · ` : "";
		let child: Component;

		if (this.expanded) {
			const header =
				this.message.tokensBefore > 0
					? `**Conversation compacted** (${tokenStr} → ~${this.estimateTokensAfter().toLocaleString()} tokens)\n\n`
					: "**Conversation compacted**\n\n";
			child = new Markdown(header + this.message.summary, 0, 0, this.markdownTheme);
		} else {
			child = new Text(
				theme.fg("muted", "Conversation compacted") +
					" " +
					theme.fg("dim", `(${tokenDetail}${keyText("app.tools.expand")} to expand)`),
				0,
				0,
			);
		}

		const gutter = new Gutter(
			{
				width: 2,
				marker: () => theme.style("⏺", { fg: rgbColor(255, 255, 255) }),
			},
			child,
		);

		this.addChild(
			new MouseRegion(gutter, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
