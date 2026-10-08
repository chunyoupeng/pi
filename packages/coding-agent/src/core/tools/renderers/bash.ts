import { DynamicText } from "../../../modes/interactive/components/dynamic-text.ts";
import {
	TOOL_CALL_HEADER_LINES,
	TOOL_PREVIEW_LINES,
	truncateToVisualLinesFromStart,
} from "../../../modes/interactive/components/visual-truncate.ts";
import { formatCollapsedOutput, formatToolCallHeader } from "../render-utils.ts";
/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { BashToolDetails } from "../bash.ts";
import { getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const BASH_PREVIEW_LINES = TOOL_PREVIEW_LINES;
export const BASH_UPDATE_THROTTLE_MS = 100;
class BashResultRenderComponent extends Container {}
function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}
function formatShellCall(args: { command?: string; timeout?: number } | undefined, headerName: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : "...";
	return formatToolCallHeader(headerName, commandDisplay, theme) + timeoutSuffix;
}
function rebuildBashResultRenderComponent(
	component: Container,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
	isError: boolean,
	durationMs: number | undefined,
): void {
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	const styleLine = isError
		? (line: string) => theme.fg("error", line)
		: (line: string) => theme.fg("toolOutput", line);
	// const summary = isError ? undefined : theme.fg("muted", `${totalLines} stdout`);
	const summary = "";
	const durationNote =
		!options.isPartial && durationMs !== undefined
			? `Took ${formatDuration(durationMs)}`
			: startedAt !== undefined
				? `${options.isPartial ? "Elapsed" : "Took"} ${formatDuration((endedAt ?? Date.now()) - startedAt)}`
				: undefined;
	if (output) {
		component.addChild(
			new DynamicText(
				(width) =>
					`${formatCollapsedOutput(output, theme, {
						expanded: options.expanded,
						maxLines: BASH_PREVIEW_LINES,
						fromEnd: true,
						hintPosition: "after",
						summary,
						styleLine,
						trailingNote: durationNote,
						width,
					})}`,
			),
		);
	} else if (summary) {
		component.addChild(new Text(`${summary}`, 0, 0));
	} else if (durationNote) {
		component.addChild(new Text(theme.fg("muted", durationNote), 0, 0));
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}
}

/** Shell renderers are shared by bash and powershell, which differ only in the prompt they display. */
export function createShellRenderers(prompt: string): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const component =
				context.lastComponent instanceof BashCallHeaderComponent
					? context.lastComponent
					: new BashCallHeaderComponent();
			component.setHeader(
				formatShellCall(
					args as { command?: string; timeout?: number } | undefined,
					prompt === "$" ? "Bash" : "PowerShell",
				),
			);
			return component;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent instanceof BashResultRenderComponent ? context.lastComponent : undefined) ??
				new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
				context.isError,
				context.durationMs,
			);
			component.invalidate();
			return component;
		},
	};
}

class BashCallHeaderComponent {
	private header = "";

	setHeader(header: string): void {
		this.header = header;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return truncateToVisualLinesFromStart(this.header, TOOL_CALL_HEADER_LINES, width).visualLines;
	}
}
