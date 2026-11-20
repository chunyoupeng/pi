import { Box, Container, MouseRegion, Spacer, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { formatToolDuration } from "../../../core/tools/render-utils.ts";
import type { CodemodeToolDetails } from "../../../extensions/codemode/tool.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { Gutter } from "./gutter.ts";
import {
	type ToolCallHandle,
	ToolExecutionComponent,
	type ToolExecutionOptions,
	type ToolExecutionResult,
	type ToolRenderers,
} from "./tool-execution.ts";

const STATUS_BULLET = "⏺";
const CALL_GUTTER_WIDTH = 2;
const DETAILS_GUTTER_WIDTH = 5;
const DETAILS_BRANCH = "└─";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

function toolNameColor(name: string): ThemeColor {
	if (READ_TOOLS.has(name)) return "accent";
	if (WRITE_TOOLS.has(name)) return "warning";
	if (SHELL_TOOLS.has(name)) return "bashMode";
	return "syntaxFunction";
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : formatToolDuration(ms);
}

interface CodemodeGroupEntry {
	readonly toolCallId: string;
	readonly component: ToolExecutionComponent;
	isPartial: boolean;
	result?: ToolExecutionResult;
}

/**
 * Groups consecutive `codemode` tool calls so that when tool output previews are collapsed
 * (e.g. after turn end or on session reload), the entire consecutive run renders as a compact
 * header + `└─` detail line summarizing aggregated nested tool counts and total duration:
 *
 * ```
 * ⏺ Codemode · 4 runs
 *   └─ read ×2 · bash ×5 · edit ×1  (3.2s)
 * ```
 *
 * While running, uncollapsed, or expanded, each call renders through its normal
 * {@link ToolExecutionComponent}.
 */
export class CodemodeGroupComponent extends Container {
	private readonly summarySpacer: Spacer;
	private readonly summaryBox: Box;
	private readonly summaryGutter: Gutter;
	private readonly detailsGutter: Gutter;
	private readonly summaryRegion: MouseRegion;
	private readonly childrenContainer: Container;
	private readonly ui: TUI;
	private readonly cwd: string;
	private readonly entries: CodemodeGroupEntry[] = [];
	private readonly handles: ToolCallHandle[] = [];
	private expanded = false;
	private previewCollapsed = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private sealed = false;

	constructor(options: ToolExecutionOptions = {}, ui: TUI, cwd: string) {
		super();
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
		this.ui = ui;
		this.cwd = cwd;

		this.summarySpacer = new Spacer(1);
		this.summaryBox = new Box(0, 0);
		this.summaryGutter = new Gutter({ width: CALL_GUTTER_WIDTH, marker: () => this.renderStatusBullet() });
		this.detailsGutter = new Gutter({
			width: DETAILS_GUTTER_WIDTH,
			marker: () => `  ${theme.fg("dim", DETAILS_BRANCH)}`,
		});
		this.summaryRegion = new MouseRegion(this.summaryBox, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(true);
			this.ui.requestRender();
			return { handled: true };
		});
		this.childrenContainer = new Container();
	}

	addCall(toolCallId: string, args: unknown, toolDefinition: ToolRenderers | undefined): ToolCallHandle {
		const component = new ToolExecutionComponent(
			"codemode",
			toolCallId,
			args,
			{
				showImages: this.showImages,
				imageWidthCells: this.imageWidthCells,
				outputPad: this.outputPad,
			},
			toolDefinition,
			this.ui,
			this.cwd,
		);
		component.setExpanded(this.expanded);
		component.setPreviewCollapsed(this.previewCollapsed);

		const entry: CodemodeGroupEntry = {
			toolCallId,
			component,
			isPartial: true,
		};
		this.entries.push(entry);
		this.childrenContainer.addChild(component);

		const handle: ToolCallHandle = {
			getToolName: () => "codemode",
			updateArgs: (nextArgs) => {
				component.updateArgs(nextArgs);
			},
			markExecutionStarted: () => {
				component.markExecutionStarted();
			},
			setArgsComplete: () => {
				component.setArgsComplete();
			},
			updateResult: (result, isPartial = false) => {
				entry.result = result;
				entry.isPartial = isPartial;
				component.updateResult(result, isPartial);
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
		for (const entry of this.entries) {
			entry.component.setExpanded(expanded);
		}
		this.updateDisplay();
	}

	setPreviewCollapsed(collapsed: boolean): void {
		if (this.previewCollapsed === collapsed) return;
		this.previewCollapsed = collapsed;
		for (const entry of this.entries) {
			entry.component.setPreviewCollapsed(collapsed);
		}
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		for (const entry of this.entries) {
			entry.component.setOutputPad(outputPad);
		}
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		for (const entry of this.entries) {
			entry.component.setShowImages(show);
		}
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		for (const entry of this.entries) {
			entry.component.setImageWidthCells(this.imageWidthCells);
		}
		this.updateDisplay();
	}

	dispose(): void {
		for (const entry of this.entries) {
			entry.component.dispose();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		// When expanded from the collapsed summary state, a left-click collapses the whole group back.
		if (!this.isCollapsedSummary() && this.previewCollapsed && this.expanded) {
			if (event.type === "click" && event.button === "left") {
				this.setExpanded(false);
				this.ui.requestRender();
				return {
					handled: true,
					target: {
						component: this,
						originX: event.screenX - event.x,
						originY: event.screenY - event.y,
						width: event.width,
						height: event.height,
					},
				};
			}
		}
		return super.handleMouse(event);
	}

	private isInProgress(): boolean {
		return this.entries.some((entry) => !entry.result || entry.isPartial);
	}

	private isCollapsedSummary(): boolean {
		return this.previewCollapsed && !this.expanded && this.entries.length > 0 && !this.isInProgress();
	}

	private renderStatusBullet(): string {
		const hasError = this.entries.some((entry) => entry.result?.isError);
		return theme.fg(hasError ? "error" : "success", STATUS_BULLET);
	}

	private formatSummaryHeader(): string {
		const title = theme.fg("toolTitle", theme.bold("Codemode"));
		if (this.entries.length > 1) {
			return `${title} ${theme.fg("dim", "·")} ${theme.fg("muted", `${this.entries.length} runs`)}`;
		}
		return title;
	}

	private formatSummaryDetails(): string | undefined {
		const counts = new Map<string, number>();
		let failedNestedCalls = 0;
		let failedScripts = 0;
		let totalDurationMs = 0;
		let hasDuration = false;

		for (const entry of this.entries) {
			if (entry.result?.isError) failedScripts++;
			if (entry.result?.durationMs !== undefined) {
				totalDurationMs += entry.result.durationMs;
				hasDuration = true;
			}
			const calls = (entry.result?.details as CodemodeToolDetails | undefined)?.calls;
			if (!calls) continue;
			for (const call of calls) {
				counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
				if (call.status === "error") failedNestedCalls++;
			}
		}

		const parts: string[] = [];
		for (const [name, count] of counts.entries()) {
			parts.push(`${theme.fg(toolNameColor(name), name)} ${theme.fg("dim", `×${count}`)}`);
		}
		const failedCount = failedNestedCalls > 0 ? failedNestedCalls : failedScripts;
		if (failedCount > 0) {
			parts.push(theme.fg("error", `${failedCount} failed`));
		}

		const body = parts.join(` ${theme.fg("dim", "·")} `);
		const duration = hasDuration ? theme.fg("dim", `(${formatDuration(totalDurationMs)})`) : "";
		if (body && duration) return `${body}  ${duration}`;
		return body || duration || undefined;
	}

	private updateDisplay(): void {
		this.clear();
		if (this.entries.length === 0) return;

		if (this.isCollapsedSummary()) {
			this.summaryBox.setBgFn(undefined);
			this.summaryBox.setPaddingX(this.outputPad);
			this.summaryBox.clear();
			this.summaryGutter.setChild(new Text(this.formatSummaryHeader(), 0, 0));
			this.summaryBox.addChild(this.summaryGutter);
			const details = this.formatSummaryDetails();
			if (details) {
				this.detailsGutter.setChild(new Text(details, 0, 0));
				this.summaryBox.addChild(this.detailsGutter);
			}
			this.addChild(this.summarySpacer);
			this.addChild(this.summaryRegion);
		} else {
			this.addChild(this.childrenContainer);
		}
	}
}
