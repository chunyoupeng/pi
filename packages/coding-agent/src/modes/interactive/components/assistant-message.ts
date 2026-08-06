import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Throttle interval for streamed Markdown flushes. */
const STREAM_FLUSH_MS = 64;

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private thinkingExpanded = false;
	private streaming = false;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingFlush = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		_hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.applyContent(this.lastMessage);
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.thinkingExpanded === expanded) return;
		this.thinkingExpanded = expanded;
		if (this.lastMessage) {
			this.applyContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.applyContent(this.lastMessage);
		}
	}

	/** Kept for API compatibility; thinking body is no longer labeled when hidden. */
	setHiddenThinkingLabel(_label: string): void {}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.applyContent(this.lastMessage);
		}
	}

	/** Mark whether this component is receiving live stream updates. */
	setStreaming(streaming: boolean): void {
		this.streaming = streaming;
		if (!streaming) {
			this.flushPending(true);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	/**
	 * Update displayed content. While streaming, flushes are throttled / paragraph-batched.
	 * Pass force=true (or call setStreaming(false)) to flush immediately.
	 */
	updateContent(message: AssistantMessage, force = false): void {
		this.lastMessage = message;

		if (!this.streaming || force) {
			this.flushPending(true);
			this.applyContent(message);
			return;
		}

		this.pendingFlush = true;
		const shouldFlushNow = this.shouldFlushForMessage(message);
		if (shouldFlushNow) {
			this.flushPending(true);
			return;
		}

		if (this.flushTimer === undefined) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = undefined;
				this.flushPending(false);
			}, STREAM_FLUSH_MS);
		}
	}

	dispose(): void {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
	}

	private shouldFlushForMessage(message: AssistantMessage): boolean {
		if (message.content.some((c) => c.type === "toolCall")) {
			return true;
		}
		if (message.stopReason === "length" || message.stopReason === "error" || message.stopReason === "aborted") {
			return true;
		}
		const text = message.content
			.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("");
		return text.endsWith("\n\n") || text.endsWith("\n");
	}

	private flushPending(force: boolean): void {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (!this.pendingFlush && !force) {
			return;
		}
		this.pendingFlush = false;
		if (this.lastMessage) {
			this.applyContent(this.lastMessage);
		}
	}

	private applyContent(message: AssistantMessage): void {
		this.contentContainer.clear();

		const showThinking = !this.hideThinkingBlock && this.thinkingExpanded;
		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (showThinking && c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme));
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Thinking body is hidden by default. Only show when the user has
				// disabled hideThinkingBlock and expanded thinking.
				if (!showThinking) {
					continue;
				}

				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				this.contentContainer.addChild(
					new Markdown(thinkingBlocks.join("\n\n"), this.outputPad, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					theme.fg(
						"error",
						"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					),
					this.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}

/** Estimate output tokens from streamed assistant content (chars/4 heuristic). */
export function estimateAssistantOutputTokens(message: AssistantMessage): number {
	if (message.usage?.output && message.usage.output > 0) {
		return message.usage.output;
	}
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else if (block.type === "toolCall") {
			chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
		}
	}
	return Math.ceil(chars / 4);
}
