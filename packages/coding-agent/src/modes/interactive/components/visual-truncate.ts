/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by both tool-execution.ts and bash-execution.ts for consistent behavior.
 */

import { Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Default collapsed preview lines for Claude-style tool output. */
export const TOOL_PREVIEW_LINES = 3;

/** Default max visual lines for tool call headers like `Bash(cmd)`. */
export const TOOL_CALL_HEADER_LINES = 3;

export interface VisualTruncateResult {
	/** The visual lines to display */
	visualLines: string[];
	/** Number of visual lines that were skipped (hidden) */
	skippedCount: number;
}

function renderVisualLines(text: string, width: number, paddingX: number): string[] {
	if (!text) {
		return [];
	}
	const tempText = new Text(text, paddingX, 0);
	return tempText.render(width);
}

/**
 * Truncate text to a maximum number of visual lines (from the end).
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @returns The truncated visual lines and count of skipped lines
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	const allVisualLines = renderVisualLines(text, width, paddingX);
	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	return {
		visualLines: allVisualLines.slice(-maxVisualLines),
		skippedCount: allVisualLines.length - maxVisualLines,
	};
}

/**
 * Truncate text to a maximum number of visual lines (from the start).
 */
export function truncateToVisualLinesFromStart(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	const allVisualLines = renderVisualLines(text, width, paddingX);
	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	const truncatedLines = allVisualLines.slice(0, maxVisualLines);
	if (truncatedLines.length > 0) {
		const last = truncatedLines[truncatedLines.length - 1]!;
		truncatedLines[truncatedLines.length - 1] = truncateToWidth(last, Math.max(1, width - paddingX * 2), "…");
	}
	return {
		visualLines: truncatedLines,
		skippedCount: allVisualLines.length - maxVisualLines,
	};
}

export interface FoldOptions {
	/** Horizontal padding the caller will add around each line. */
	paddingX?: number;
	/** Keep the last N lines instead of the first N. */
	fromEnd?: boolean;
}

/**
 * Fold text down to a preview of at most `maxVisualLines` rendered lines.
 *
 * Folding is measured in visual lines (post-wrap) rather than logical lines so a
 * preview always occupies the same height regardless of how long each line is.
 * Hiding a single line would cost as much vertical space to announce as to show,
 * so that case renders in full instead.
 */
export function foldToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	options: FoldOptions = {},
): VisualTruncateResult {
	const paddingX = options.paddingX ?? 0;
	// Rendering pads every line out to the full width; the caller re-wraps these
	// lines as text, where that padding would only add trailing blanks.
	const allVisualLines = renderVisualLines(text, width, paddingX).map((line) => line.trimEnd());
	if (allVisualLines.length <= maxVisualLines + 1) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}
	return {
		visualLines: options.fromEnd ? allVisualLines.slice(-maxVisualLines) : allVisualLines.slice(0, maxVisualLines),
		skippedCount: allVisualLines.length - maxVisualLines,
	};
}
