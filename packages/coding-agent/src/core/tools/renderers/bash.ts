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
import { getTextOutput, invalidArgText, startToolTimer, str, toolTimerText } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const BASH_PREVIEW_LINES = TOOL_PREVIEW_LINES;
export const BASH_UPDATE_THROTTLE_MS = 100;
class BashResultRenderComponent extends Container {}
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
	isError: boolean,
	timerText: string | undefined,
): void {
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	const fullOutputError = result.details?.fullOutputError;
	// The model's footer names the file or why it could not be saved; the warning below says the same.
	const footerMarker = fullOutputPath ?? fullOutputError;
	if (!options.isPartial && truncation?.truncated && footerMarker && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(footerMarker)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	const styleLine = isError
		? (line: string) => theme.fg("error", line)
		: (line: string) => theme.fg("toolOutput", line);
	// const summary = isError ? undefined : theme.fg("muted", `${totalLines} stdout`);
	const summary = "";
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
						trailingNote: timerText,
						width,
					})}`,
			),
		);
	} else if (summary) {
		component.addChild(new Text(`${summary}`, 0, 0));
	} else if (timerText) {
		component.addChild(new Text(theme.fg("muted", timerText), 0, 0));
	}

	if (truncation?.truncated || fullOutputPath || fullOutputError) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		} else if (fullOutputError) {
			warnings.push(`Could not save the full output: ${fullOutputError}`);
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

/** `renderCall` functions made by {@link createShellRenderers}, so the TUI can tell built-in shell rendering from an override. */
const builtInShellRenderCalls = new WeakSet<object>();

/** Whether a tool's renderers are the built-in bash/powershell ones (not replaced by an extension). */
export function isBuiltInShellRenderers(renderers: { renderCall?: object } | undefined): boolean {
	return renderers?.renderCall !== undefined && builtInShellRenderCalls.has(renderers.renderCall);
}

/** Shell renderers are shared by bash and powershell, which differ only in the prompt they display. */
export function createShellRenderers(prompt: string): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	const renderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
		renderCall(args, _theme, context) {
			startToolTimer(context);
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
			component.setExpanded(context.expanded);
			return component;
		},
		renderResult(result, options, _theme, context) {
			const timerText = toolTimerText(context, options.isPartial);
			const component =
				(context.lastComponent instanceof BashResultRenderComponent ? context.lastComponent : undefined) ??
				new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				context.isError,
				timerText,
			);
			component.invalidate();
			return component;
		},
	};
	builtInShellRenderCalls.add(renderers.renderCall!);
	return renderers;
}

class BashCallHeaderComponent {
	private header = "";
	private expanded = false;

	setHeader(header: string): void {
		this.header = header;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		if (this.expanded) {
			return new Text(this.header, 0, 0).render(width);
		}
		return truncateToVisualLinesFromStart(this.header, TOOL_CALL_HEADER_LINES, width, 0, "…)").visualLines;
	}
}
