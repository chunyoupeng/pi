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
	/** Muted summary line after the body, e.g. `12 stdout`. */
	summary?: string;
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
	if (lines.length === 0 && !options.summary) {
		return "";
	}

	const parts: string[] = [];
	if (options.expanded) {
		if (lines.length > 0) {
			parts.push(lines.map(styleLine).join("\n"));
		}
	} else {
		// Style before folding: wrapping happens on the styled text, so measuring it
		// unstyled would mispredict where lines break.
		const styled = lines.map(styleLine).join("\n");
		const fold =
			options.width !== undefined
				? foldToVisualLines(styled, maxLines, options.width, { fromEnd: options.fromEnd })
				: foldLogicalLines(styled, maxLines, options.fromEnd);
		// The hint sits on the side the hidden lines are on, so it reads as a
		// continuation of the output rather than a footnote in the wrong place.
		if (fold.skippedCount > 0 && options.fromEnd) {
			parts.push(formatOmittedLinesHint(fold.skippedCount, theme));
		}
		if (fold.visualLines.length > 0) {
			parts.push(fold.visualLines.join("\n"));
		}
		if (fold.skippedCount > 0 && !options.fromEnd) {
			parts.push(formatOmittedLinesHint(fold.skippedCount, theme));
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
