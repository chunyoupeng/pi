import { DynamicText } from "../../../modes/interactive/components/dynamic-text.ts";
import { TOOL_PREVIEW_LINES } from "../../../modes/interactive/components/visual-truncate.ts";
import { formatCollapsedOutput } from "../render-utils.ts";
/**
 * Presentation for the read tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `read.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { getReadmePath } from "../../../config.ts";
import { keyText } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import { resolveToCwd } from "../path-utils.ts";
import type { ReadToolDetails } from "../read.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../truncate.ts";

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };
function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	// Strict tool schemas make models send null for omitted optional fields.
	if (args?.offset == null && args?.limit == null) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit != null ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}
function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	const range = formatReadLineRange(args, theme);
	return `${theme.fg("toolTitle", theme.bold("Read("))}${pathDisplay}${range}${theme.fg("toolTitle", theme.bold(")"))}`;
}
function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}
function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}
function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}
function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}
function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`Read ${classification.kind}(`)) +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		theme.fg("toolTitle", theme.bold(")")) +
		expandHint
	);
}
function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
	width: number,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const totalLines = lines.length;
	const styleLine = isError
		? (line: string) => theme.fg("error", replaceTabs(line))
		: lang
			? (line: string) => replaceTabs(line)
			: (line: string) => theme.fg("toolOutput", replaceTabs(line));

	let text = "";
	if (isError) {
		text = `\n${formatCollapsedOutput(lines.join("\n"), theme, {
			expanded: options.expanded,
			maxLines: TOOL_PREVIEW_LINES,
			styleLine,
			width,
		})}`;
	} else if (options.expanded) {
		text = `\n${formatCollapsedOutput(lines.join("\n"), theme, {
			expanded: true,
			styleLine,
			width,
		})}`;
	} else if (totalLines > 0) {
		text = `\n${formatCollapsedOutput(lines.join("\n"), theme, {
			expanded: false,
			maxLines: TOOL_PREVIEW_LINES,
			styleLine,
			width,
		})}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export const readRenderers: Pick<ToolDefinition<any, ReadToolDetails | undefined>, "renderCall" | "renderResult"> = {
	renderCall(rawArgs, theme, context) {
		const args = rawArgs as ReadRenderArgs | undefined;
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
		text.setText(
			classification ? formatCompactReadCall(classification, args, theme) : formatReadCall(args, theme, context.cwd),
		);
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as DynamicText | undefined) ?? new DynamicText();
		text.setBuilder((width) =>
			formatReadResult(
				context.args as ReadRenderArgs | undefined,
				result,
				options,
				theme,
				context.showImages,
				context.cwd,
				context.isError,
				width,
			),
		);
		return text;
	},
};
