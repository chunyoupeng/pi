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
import { getTextOutput as getRenderedTextOutput, renderToolPath, str } from "../../../core/tools/render-utils.ts";
import { formatReadResult, type ReadRenderArgs, styledReadLineRange } from "../../../core/tools/renderers/read.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { DynamicText } from "./dynamic-text.ts";
import { Gutter } from "./gutter.ts";
import type { ToolCallHandle, ToolExecutionOptions, ToolExecutionResult } from "./tool-execution.ts";

const STATUS_BULLET = "⏺";
const RUNNING_BULLET_FRAMES = ["border", "dim"] as const;
const RUNNING_BULLET_INTERVAL_MS = 500;
const CALL_GUTTER_WIDTH = 2;
const FILE_GUTTER_WIDTH = 5;
const FILE_BRANCH = "└─";
const ERROR_SUMMARY_MAX_WIDTH = 80;

interface ReadGroupEntry {
	readonly toolCallId: string;
	args: ReadRenderArgs | undefined;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	result?: ToolExecutionResult;
	resultComponent?: DynamicText;
}

/**
 * Compact grouped display for consecutive built-in `read` tool calls.
 *
 * Shows a single `Reading N files...` / `Read N files` header with one `└─ <path>` line per read,
 * expanding to full file contents when toggled via `Ctrl+O` or mouse click.
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
		this.callGutter = new Gutter({ width: CALL_GUTTER_WIDTH, marker: () => this.renderStatusBullet() });
		this.contentRegion = new MouseRegion(this.contentBox, (event) => {
			if (!this.hasAnyResult() || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			this.ui.requestRender();
			return { handled: true };
		});
		this.addChild(this.contentRegion);
	}

	addCall(toolCallId: string, args: unknown): ToolCallHandle {
		const entry: ReadGroupEntry = {
			toolCallId,
			args: args as ReadRenderArgs | undefined,
			executionStarted: false,
			argsComplete: false,
			isPartial: true,
		};
		this.entries.push(entry);

		const handle: ToolCallHandle = {
			getToolName: () => "read",
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

	private renderStatusBullet(): string {
		if (this.isRunning()) {
			const frame =
				RUNNING_BULLET_FRAMES[Math.floor(Date.now() / RUNNING_BULLET_INTERVAL_MS) % RUNNING_BULLET_FRAMES.length];
			return theme.fg(frame, STATUS_BULLET);
		}
		if (this.isInProgress()) {
			return theme.fg("border", STATUS_BULLET);
		}
		const hasError = this.entries.some((entry) => entry.result?.isError);
		return theme.fg(hasError ? "error" : "success", STATUS_BULLET);
	}

	private startBlink(): void {
		if (this.blinkInterval || !this.isRunning()) return;
		this.blinkInterval = setInterval(() => this.ui.requestRender(), RUNNING_BULLET_INTERVAL_MS);
	}

	private stopBlink(): void {
		if (this.blinkInterval) {
			clearInterval(this.blinkInterval);
			this.blinkInterval = undefined;
			this.ui.requestRender();
		}
	}

	private formatHeader(): string {
		const count = this.entries.length;
		const noun = count === 1 ? "file" : "files";
		const label = this.isInProgress() ? `Reading ${count} ${noun}...` : `Read ${count} ${noun}`;
		return theme.fg("toolTitle", theme.bold(label));
	}

	private formatEntryPath(entry: ReadGroupEntry): string {
		const rawPath = str(entry.args?.file_path ?? entry.args?.path);
		const pathDisplay = renderToolPath(rawPath, theme, this.cwd);
		const range = styledReadLineRange(entry.args, theme);
		let text = `${pathDisplay}${range}`;
		if (!this.expanded && entry.result?.isError) {
			const firstErrorLine = getRenderedTextOutput(entry.result, this.showImages)
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0);
			const summary = firstErrorLine ? truncateToWidth(firstErrorLine, ERROR_SUMMARY_MAX_WIDTH, "…") : "error";
			text += ` ${theme.fg("error", summary)}`;
		}
		return text;
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
				const fileGutter = new Gutter(
					{
						width: FILE_GUTTER_WIDTH,
						marker: () => `  ${theme.fg("dim", FILE_BRANCH)}`,
					},
					new Text(this.formatEntryPath(entry), 0, 0),
				);
				this.contentBox.addChild(fileGutter);

				if (this.expanded && entry.result) {
					const result = entry.result;
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
					const bodyGutter = new Gutter({ width: FILE_GUTTER_WIDTH, marker: () => "" }, resultText);
					this.contentBox.addChild(bodyGutter);
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
