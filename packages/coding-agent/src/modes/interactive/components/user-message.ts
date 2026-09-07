import { Container, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private markdown!: Markdown;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.markdown.invalidate();
	}

	override invalidate(): void {
		super.invalidate();
		this.markdown.invalidate();
	}

	private rebuild(): void {
		this.clear();
		this.markdown = new Markdown(
			this.text,
			0,
			0,
			this.markdownTheme,
			{
				color: (content: string) => theme.fg("userMessageText", content),
			},
			{
				preserveOrderedListMarkers: true,
				preserveBackslashEscapes: true,
				transform: createMarkdownTransform("user", false, this.markdownTransformers),
			},
		);
	}

	override render(width: number): string[] {
		const prefixSymbol = "❯";
		const prefixString = `${theme.fg("accent", prefixSymbol)} `;
		const prefixWidth = visibleWidth(prefixSymbol) + 1;
		const maxPadding = Math.max(0, Math.floor((width - prefixWidth) / 2));
		const outputPad = Math.min(this.outputPad, maxPadding);
		const contentWidth = Math.max(1, width - outputPad * 2 - prefixWidth);

		const childLines = this.markdown.render(contentWidth);
		if (childLines.length === 0) {
			return [];
		}

		const leftPad = " ".repeat(outputPad);
		const rightPad = " ".repeat(outputPad);
		const continuationIndent = " ".repeat(prefixWidth);

		const lines: string[] = [];
		for (let i = 0; i < childLines.length; i++) {
			const linePrefix = i === 0 ? prefixString : continuationIndent;
			const renderedLine = `${leftPad}${linePrefix}${childLines[i]}${rightPad}`;
			lines.push(truncateToWidth(renderedLine, width));
		}

		if (lines.length === 1) {
			lines[0] = OSC133_ZONE_START + OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[0];
		} else {
			lines[0] = OSC133_ZONE_START + lines[0];
			lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		}
		return lines;
	}
}
