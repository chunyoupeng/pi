import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	Box,
	Container,
	getCapabilities,
	Image,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ReadToolDetails } from "../../../core/tools/read.ts";
import {
	getTextOutput as getRenderedTextOutput,
	renderToolPath,
	shortenPath,
	str,
} from "../../../core/tools/render-utils.ts";
import { formatReadResult, type ReadRenderArgs, styledReadLineRange } from "../../../core/tools/renderers/read.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { DynamicText } from "./dynamic-text.ts";
import { Gutter } from "./gutter.ts";
import type { ToolCallHandle, ToolExecutionOptions, ToolExecutionResult } from "./tool-execution.ts";

/** Re-render interval while a call runs, so live shell output and the header stay current. */
const RUNNING_REFRESH_INTERVAL_MS = 500;
const CALL_GUTTER_WIDTH = 2;
const FILE_GUTTER_WIDTH = 5;
const FILE_BRANCH = "└─";
const ERROR_SUMMARY_MAX_WIDTH = 80;
const SHELL_COMMAND_MAX_WIDTH = 100;
/** Output lines shown under a shell command while its preview is visible. */
const SHELL_PREVIEW_LINES = 4;

/** What a grouped call did, which decides its verb and noun in the group header. */
export type ActivityKind = "read" | "list" | "search" | "shell";

/** Built-in tools that join an activity group, by the kind of activity they count as. */
export const ACTIVITY_KIND_BY_TOOL: Readonly<Record<string, ActivityKind>> = {
	read: "read",
	ls: "list",
	grep: "search",
	find: "search",
	bash: "shell",
	powershell: "shell",
};

const ACTIVITY_LABELS: Readonly<Record<ActivityKind, { done: string; running: string; one: string; many: string }>> = {
	read: { done: "Read", running: "Reading", one: "file", many: "files" },
	list: { done: "Listed", running: "Listing", one: "directory", many: "directories" },
	search: { done: "Searched for", running: "Searching for", one: "pattern", many: "patterns" },
	shell: { done: "Ran", running: "Running", one: "shell command", many: "shell commands" },
};

interface ActivityArgs {
	file_path?: unknown;
	path?: unknown;
	pattern?: unknown;
	command?: unknown;
}

interface ReadGroupEntry {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly kind: ActivityKind;
	args: ReadRenderArgs | undefined;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	result?: ToolExecutionResult;
	resultComponent?: DynamicText;
}

/**
 * Compact grouped display for consecutive built-in exploration calls (`read`, `ls`, `grep`, `find`, shell).
 *
 * Shows one summary header such as `Read 2 files, listed 1 directory, ran 3 shell commands` with one
 * `└─ <target>` line per call. A running shell command also shows the tail of its live output. The whole
 * group expands to full results when toggled via `Ctrl+O` or mouse click. Any assistant text between calls
 * starts a new group, so a model that narrates its steps gets one summary line per step.
 */
export class ReadGroupComponent extends Container {
	private readonly contentBox: Box;
	private readonly contentRegion: MouseRegion;
	private readonly callGutter: Gutter;
	private readonly ui: TUI;
	private readonly cwd: string;
	private readonly entries: ReadGroupEntry[] = [];
	private readonly handles: ToolCallHandle[] = [];
	private imageComponents: Image[] = [];
	private imageSources: Array<{ data: string; mimeType: string; widthCells: number }> = [];
	private imageSpacers: Spacer[] = [];
	private expanded = false;
	private previewCollapsed = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private argsPending = false;
	private sealed = false;
	private blinkInterval: NodeJS.Timeout | undefined;

	constructor(options: ToolExecutionOptions = {}, ui: TUI, cwd: string) {
		super();
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));
		this.contentBox = new Box(0, 0);
		// No status bullet: the header starts in the assistant text column; failures show on their `└─` line.
		this.callGutter = new Gutter({ width: CALL_GUTTER_WIDTH, marker: () => "" });
		this.contentRegion = new MouseRegion(this.contentBox, (event) => {
			if (!this.hasAnyResult() || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			this.ui.requestRender();
			return { handled: true };
		});
		this.addChild(this.contentRegion);
	}

	addCall(toolCallId: string, args: unknown, toolName = "read"): ToolCallHandle {
		const entry: ReadGroupEntry = {
			toolCallId,
			toolName,
			kind: ACTIVITY_KIND_BY_TOOL[toolName] ?? "read",
			args: args as ReadRenderArgs | undefined,
			executionStarted: false,
			argsComplete: false,
			isPartial: true,
		};
		this.entries.push(entry);

		const handle: ToolCallHandle = {
			getToolName: () => entry.toolName,
			updateArgs: (nextArgs) => {
				entry.args = nextArgs as ReadRenderArgs | undefined;
				this.argsPending = true;
				this.ui.requestRender();
			},
			markExecutionStarted: () => {
				entry.executionStarted = true;
				this.updateDisplay();
				this.startBlink();
				this.ui.requestRender();
			},
			setArgsComplete: () => {
				entry.argsComplete = true;
				this.updateDisplay();
				this.ui.requestRender();
			},
			updateResult: (result, isPartial = false) => {
				entry.result = result;
				entry.isPartial = isPartial;
				if (!this.isRunning()) {
					this.stopBlink();
				}
				this.updateDisplay();
			},
			setExpanded: (expanded) => {
				this.setExpanded(expanded);
			},
			setPreviewCollapsed: (collapsed) => {
				this.setPreviewCollapsed(collapsed);
			},
		};
		this.handles.push(handle);
		this.updateDisplay();
		return handle;
	}

	seal(): void {
		this.sealed = true;
	}

	isSealed(): boolean {
		return this.sealed;
	}

	isActiveInTurn(turnTools: ReadonlySet<ToolCallHandle>): boolean {
		return this.handles.some((handle) => turnTools.has(handle));
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	setPreviewCollapsed(collapsed: boolean): void {
		if (this.previewCollapsed === collapsed) return;
		this.previewCollapsed = collapsed;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	dispose(): void {
		this.stopBlink();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): readonly string[] {
		if (this.argsPending) this.updateDisplay();
		if (this.entries.length === 0) return [];
		return super.render(width);
	}

	/**
	 * Once previews collapse (turn end with `collapseToolOutput` on), successful calls drop out and a finished
	 * group is just its header. During the turn every call stays listed; failed calls always stay listed.
	 */
	private isHiddenWhenCollapsed(entry: ReadGroupEntry): boolean {
		return this.isPreviewHidden() && entry.result !== undefined && !entry.isPartial && !entry.result.isError;
	}

	private hasAnyResult(): boolean {
		return this.entries.some((entry) => entry.result !== undefined);
	}

	private isInProgress(): boolean {
		return this.entries.some((entry) => !entry.result || entry.isPartial);
	}

	private isRunning(): boolean {
		return this.entries.some((entry) => entry.executionStarted && (!entry.result || entry.isPartial));
	}

	private isPreviewHidden(): boolean {
		return this.previewCollapsed && !this.expanded;
	}

	private startBlink(): void {
		if (this.blinkInterval || !this.isRunning()) return;
		this.blinkInterval = setInterval(() => this.ui.requestRender(), RUNNING_REFRESH_INTERVAL_MS);
	}

	private stopBlink(): void {
		if (this.blinkInterval) {
			clearInterval(this.blinkInterval);
			this.blinkInterval = undefined;
			this.ui.requestRender();
		}
	}

	/**
	 * `Read 2 files, ran 1 shell command` in dim text with bold counts, like a quiet status line rather than
	 * a tool title. Running kinds use the progressive verb and the header ends in `...`.
	 */
	private formatHeader(): string {
		const order: ActivityKind[] = [];
		const counts = new Map<ActivityKind, { total: number; running: boolean }>();
		for (const entry of this.entries) {
			let count = counts.get(entry.kind);
			if (!count) {
				count = { total: 0, running: false };
				counts.set(entry.kind, count);
				order.push(entry.kind);
			}
			count.total++;
			if (!entry.result || entry.isPartial) count.running = true;
		}
		const parts = order.map((kind, index) => {
			const { total, running } = counts.get(kind)!;
			const labels = ACTIVITY_LABELS[kind];
			const verb = running ? labels.running : labels.done;
			const shownVerb = index === 0 ? verb : verb.charAt(0).toLowerCase() + verb.slice(1);
			const noun = total === 1 ? labels.one : labels.many;
			return `${theme.fg("dim", `${shownVerb} `)}${theme.fg("dim", theme.bold(String(total)))}${theme.fg("dim", ` ${noun}`)}`;
		});
		const suffix = this.isInProgress() ? theme.fg("dim", "...") : "";
		return `${parts.join(theme.fg("dim", ", "))}${suffix}`;
	}

	private formatEntryTarget(entry: ReadGroupEntry): string {
		const args = entry.args as ActivityArgs | undefined;
		switch (entry.kind) {
			case "read":
				return `${renderToolPath(str(args?.file_path ?? args?.path), theme, this.cwd, { color: "muted" })}${styledReadLineRange(entry.args, theme, "muted")}`;
			case "list":
				return renderToolPath(str(args?.path), theme, this.cwd, { color: "muted", emptyFallback: "." });
			case "search": {
				const pattern = str(args?.pattern) ?? "";
				const shown = entry.toolName === "grep" ? `/${pattern}/` : pattern;
				const where = shortenPath(str(args?.path) || ".");
				return `${theme.fg("muted", shown)}${theme.fg("dim", ` in ${where}`)}`;
			}
			case "shell": {
				const command = str(args?.command) ?? "";
				const lines = command.split("\n");
				const firstLine = lines.length > 1 ? `${lines[0]} …` : command;
				const prompt = entry.toolName === "powershell" ? "PS>" : "$";
				return theme.fg("muted", truncateToWidth(`${prompt} ${firstLine || "..."}`, SHELL_COMMAND_MAX_WIDTH, "…"));
			}
		}
	}

	private formatEntryLine(entry: ReadGroupEntry): string {
		const text = this.formatEntryTarget(entry);
		if (this.expanded || !entry.result?.isError) return text;
		const output = getRenderedTextOutput(entry.result, this.showImages);
		if (entry.kind === "shell") {
			// Shell output can be long and noisy; the collapsed line only says how the command ended.
			const exitCode = output.match(/exited with code (\d+)/)?.[1];
			return `${text} ${theme.fg("error", exitCode !== undefined ? `exit ${exitCode}` : "failed")}`;
		}
		const firstErrorLine = output
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		const summary = firstErrorLine ? truncateToWidth(firstErrorLine, ERROR_SUMMARY_MAX_WIDTH, "…") : "error";
		return `${text} ${theme.fg("error", summary)}`;
	}

	/**
	 * Tail of a shell command's output while it runs, and until the turn's previews collapse
	 * (never, with `collapseToolOutput` off), so long commands show progress without filling the screen.
	 */
	private formatShellPreview(entry: ReadGroupEntry): string | undefined {
		if (entry.kind !== "shell" || !entry.result) return undefined;
		if (this.isPreviewHidden() && !entry.isPartial) return undefined;
		const lines = getRenderedTextOutput(entry.result, false)
			.split("\n")
			.filter((line) => line.trim().length > 0);
		if (lines.length === 0) return undefined;
		const color = entry.result.isError ? "error" : "dim";
		return lines
			.slice(-SHELL_PREVIEW_LINES)
			.map((line) => theme.fg(color, line))
			.join("\n");
	}

	private buildExpandedBody(entry: ReadGroupEntry, result: ToolExecutionResult): DynamicText | Text {
		if (entry.kind !== "read") {
			const output = getRenderedTextOutput(result, this.showImages).trimEnd();
			const color = result.isError ? "error" : "toolOutput";
			return new Text(output ? theme.fg(color, output) : theme.fg("dim", "(no output)"), 0, 0);
		}
		const resultText = entry.resultComponent ?? new DynamicText();
		entry.resultComponent = resultText;
		resultText.setBuilder((width) =>
			formatReadResult(
				entry.args,
				{
					content: result.content as (TextContent | ImageContent)[],
					details: result.details as ReadToolDetails | undefined,
				},
				{ expanded: true, isPartial: entry.isPartial },
				theme,
				this.showImages,
				this.cwd,
				result.isError,
				width,
			),
		);
		return resultText;
	}

	private updateDisplay(): void {
		this.argsPending = false;
		this.contentBox.setBgFn(undefined);
		this.contentBox.setPaddingX(this.outputPad);
		this.contentBox.clear();

		if (this.entries.length > 0) {
			this.callGutter.setChild(new Text(this.formatHeader(), 0, 0));
			this.contentBox.addChild(this.callGutter);

			for (const entry of this.entries) {
				if (this.isHiddenWhenCollapsed(entry)) continue;
				const fileGutter = new Gutter(
					{
						width: FILE_GUTTER_WIDTH,
						marker: () => `  ${theme.fg("dim", FILE_BRANCH)}`,
					},
					new Text(this.formatEntryLine(entry), 0, 0),
				);
				this.contentBox.addChild(fileGutter);

				if (this.expanded && entry.result) {
					const body = this.buildExpandedBody(entry, entry.result);
					this.contentBox.addChild(new Gutter({ width: FILE_GUTTER_WIDTH, marker: () => "" }, body));
				} else {
					const tail = this.formatShellPreview(entry);
					if (tail) {
						this.contentBox.addChild(
							new Gutter({ width: FILE_GUTTER_WIDTH, marker: () => "" }, new Text(tail, 0, 0)),
						);
					}
				}
			}
		}

		this.updateImages();
	}

	private updateImages(): void {
		const previousImages = this.imageComponents;
		const previousSources = this.imageSources;
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		this.imageSources = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.isPreviewHidden()) return;
		const caps = getCapabilities();
		if (!caps.images || !this.showImages) return;

		for (const entry of this.entries) {
			if (!entry.result) continue;
			const imageBlocks = entry.result.content.filter((c) => c.type === "image");
			for (const img of imageBlocks) {
				if (!img.data || !img.mimeType) continue;
				const spacer = new Spacer(1);
				this.addChild(spacer);
				this.imageSpacers.push(spacer);
				const source = { data: img.data, mimeType: img.mimeType, widthCells: this.imageWidthCells };
				const index = this.imageComponents.length;
				const previous = previousSources[index];
				const imageComponent =
					previous?.data === source.data &&
					previous.mimeType === source.mimeType &&
					previous.widthCells === source.widthCells
						? previousImages[index]
						: new Image(
								source.data,
								source.mimeType,
								{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
								{ maxWidthCells: source.widthCells },
							);
				if (source.mimeType !== "image/png") {
					ensurePngTranscoder(() => {
						this.invalidate();
						this.ui.requestRender();
					});
				}
				this.imageComponents.push(imageComponent);
				this.imageSources.push(source);
				this.addChild(imageComponent);
			}
		}
	}
}
