import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { foldToVisualLines, type VisualTruncateResult } from "../../modes/interactive/components/visual-truncate.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { ToolRenderContext } from "../extensions/types.ts";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function parseLineNumber(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim() !== "") value = Number(value);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Format finite numbers or numeric strings as a read line range, omitting malformed ranges. */
export function formatReadLineRange(offset: unknown, limit: unknown): string {
	// Strict schemas represent omitted optional arguments as null.
	if (offset == null && limit == null) return "";
	const start = offset == null ? 1 : parseLineNumber(offset);
	if (start === undefined) return "";
	if (limit == null) return `:${start}`;
	const count = parseLineNumber(limit);
	if (count === undefined) return "";
	const end = start + count - 1;
	return `:${start}${end ? `-${end}` : ""}`;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

const COLLAPSED_ARGS_CHARS = 100;

/**
 * Generic tool call header: the title followed by the arguments. Collapsed, they are `key=value`
 * pairs on the title line, cut to {@link COLLAPSED_ARGS_CHARS}. Expanded, each is a `key: value`
 * line below the title, with strings shown raw and continuation lines indented.
 */
export function formatToolCallWithArgs(title: string, args: unknown, theme: Theme, expanded: boolean): string {
	const header = theme.fg("toolTitle", theme.bold(title));
	if (args == null) return header;
	const entries =
		typeof args === "object" && !Array.isArray(args)
			? Object.entries(args)
			: ([["args", args]] as [string, unknown][]);
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${header} ${theme.fg("muted", preview)}`;
}

/** Duration as `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
export function formatToolDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** Renderer state of {@link startToolTimer} and {@link toolTimerText}, kept in `ToolRenderContext.state`. */
interface ToolTimerState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

/** Start the row's clock once execution starts. Call from `renderCall`. */
export function startToolTimer(context: ToolRenderContext<ToolTimerState>): void {
	const state = context.state;
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
}

/**
 * The row's timing line, from `renderResult`: `Elapsed 4.2s` while the result is partial, redrawn
 * every second, and `Took 4.2s` once it is final. Undefined when the row has no start time and no
 * recorded duration.
 */
export function toolTimerText(context: ToolRenderContext<ToolTimerState>, isPartial: boolean): string | undefined {
	const state = context.state;
	if (state.startedAt !== undefined && isPartial && !state.interval) {
		state.interval = setInterval(() => context.invalidate(), 1000);
	}
	if (!isPartial || context.isError) {
		state.endedAt ??= Date.now();
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}
	// A final result's recorded duration wins: it is monotonic and survives reloads. The renderer's own clock is the
	// fallback for live progress and for results stored without one.
	if (!isPartial && context.durationMs !== undefined) return `Took ${formatToolDuration(context.durationMs)}`;
	if (state.startedAt === undefined) return undefined;
	const endTime = state.endedAt ?? Date.now();
	return `${isPartial ? "Elapsed" : "Took"} ${formatToolDuration(endTime - state.startedAt)}`;
}

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}

/** Claude-style tool call header: `Name(args)`. */
export function formatToolCallHeader(name: string, argsText: string, theme: Theme): string {
	const args = argsText.trim();
	const body = args ? `${name}(${args})` : `${name}()`;
	return theme.fg("toolTitle", theme.bold(body));
}

export type CollapsedOutputOptions = {
	/** When true, show all lines (no preview truncation). */
	expanded?: boolean;
	/** Max lines to show when collapsed. Default 3. */
	maxLines?: number;
	/** Take last N lines when collapsed (bash-style). Default: first N. */
	fromEnd?: boolean;
	/**
	 * Where to place the omitted-lines hint. Default: same side as the hidden
	 * lines (before the preview when fromEnd, after otherwise).
	 */
	hintPosition?: "before" | "after";
	/** Muted summary line after the body, e.g. `12 stdout`. */
	summary?: string;
	/**
	 * Muted note that shares the omitted-lines hint line when present,
	 * e.g. `… +12 lines (ctrl+o to expand) · Took 1.2s`; otherwise its own final line.
	 */
	trailingNote?: string;
	/** Color each body line. Default: toolOutput. */
	styleLine?: (line: string) => string;
	/**
	 * Render width. When provided the preview is folded by visual lines, so a
	 * collapsed block keeps a fixed height even when individual lines wrap.
	 */
	width?: number;
};

/** `… +12 lines (ctrl+o to expand)`, announcing what a collapsed block hides. */
export function formatOmittedLinesHint(omitted: number, theme: Theme): string {
	const label = theme.fg("muted", `… +${omitted} ${omitted === 1 ? "line" : "lines"}`);
	const key = keyText("app.tools.expand");
	return key ? `${label} ${theme.fg("dim", `(${key} to expand)`)}` : label;
}

/**
 * Claude-style collapsed tool output:
 * up to N lines, then the omitted-lines hint, then an optional summary.
 */
export function formatCollapsedOutput(raw: string, theme: Theme, options: CollapsedOutputOptions = {}): string {
	const maxLines = options.maxLines ?? 3;
	const styleLine = options.styleLine ?? ((line: string) => theme.fg("toolOutput", line));
	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	if (lines.length === 0 && !options.summary && !options.trailingNote) {
		return "";
	}

	const note = options.trailingNote ? theme.fg("muted", options.trailingNote) : undefined;
	const parts: string[] = [];
	if (options.expanded) {
		if (lines.length > 0) {
			parts.push(lines.map(styleLine).join("\n"));
		}
		if (note) {
			parts.push(note);
		}
	} else {
		// Style before folding: wrapping happens on the styled text, so measuring it
		// unstyled would mispredict where lines break.
		const styled = lines.map(styleLine).join("\n");
		const fold =
			options.width !== undefined
				? foldToVisualLines(styled, maxLines, options.width, { fromEnd: options.fromEnd })
				: foldLogicalLines(styled, maxLines, options.fromEnd);
		// The hint sits on the side the hidden lines are on by default, so it reads
		// as a continuation of the output rather than a footnote in the wrong place.
		// hintPosition can force it after the preview instead.
		const showHint = fold.skippedCount > 0;
		const hintAfter = showHint && (!options.fromEnd || options.hintPosition === "after");
		const hintBefore = showHint && !hintAfter;
		if (hintBefore) {
			parts.push(formatOmittedLinesHint(fold.skippedCount, theme));
		}
		if (fold.visualLines.length > 0) {
			parts.push(fold.visualLines.join("\n"));
		}
		if (hintAfter) {
			parts.push(
				note
					? `${formatOmittedLinesHint(fold.skippedCount, theme)}${theme.fg("dim", " · ")}${note}`
					: formatOmittedLinesHint(fold.skippedCount, theme),
			);
		} else if (note) {
			parts.push(note);
		}
	}

	if (options.summary) {
		parts.push(options.summary);
	}
	return parts.join("\n");
}

/** Width-unaware fallback used when a caller cannot supply a render width. */
function foldLogicalLines(styled: string, maxLines: number, fromEnd?: boolean): VisualTruncateResult {
	const lines = styled.split("\n");
	if (lines.length <= maxLines + 1) {
		return { visualLines: lines, skippedCount: 0 };
	}
	return {
		visualLines: fromEnd ? lines.slice(-maxLines) : lines.slice(0, maxLines),
		skippedCount: lines.length - maxLines,
	};
}
