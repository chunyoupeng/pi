import { Box, Container, MouseRegion, Spacer, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { CodemodeToolDetails } from "../../../extensions/codemode/tool.ts";
import { theme } from "../theme/theme.ts";
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

interface CodemodeGroupEntry {
	readonly toolCallId: string;
	readonly component: ToolExecutionComponent;
	isPartial: boolean;
	result?: ToolExecutionResult;
}

/**
 * Groups consecutive `codemode` tool calls so that when tool output previews are collapsed
 * (e.g. after turn end or on session reload), the entire consecutive run renders as a single
 * compact line summarizing aggregated nested tool call counts (e.g. `codemode  read·4 edit·5`).
 *
 * While running, uncollapsed, or expanded, each call renders through its normal
 * {@link ToolExecutionComponent}.
 */
export class CodemodeGroupComponent extends Container {
	private readonly summarySpacer: Spacer;
	private readonly summaryBox: Box;
	private readonly summaryGutter: Gutter;
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

	private formatSummaryLine(): string {
		const title = theme.fg("toolTitle", theme.bold("codemode"));
		const counts = new Map<string, number>();
		for (const entry of this.entries) {
			const calls = (entry.result?.details as CodemodeToolDetails | undefined)?.calls;
			if (!calls) continue;
			for (const call of calls) {
				counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
			}
		}

		if (counts.size === 0) {
			return this.entries.length > 1 ? `${title}  ${theme.fg("muted", `×${this.entries.length}`)}` : title;
		}

		const summary = [...counts.entries()].map(([name, count]) => `${name}·${count}`).join(" ");
		return `${title}  ${theme.fg("muted", summary)}`;
	}

	private updateDisplay(): void {
		this.clear();
		if (this.entries.length === 0) return;

		if (this.isCollapsedSummary()) {
			this.summaryBox.setBgFn(undefined);
			this.summaryBox.setPaddingX(this.outputPad);
			this.summaryBox.clear();
			this.summaryGutter.setChild(new Text(this.formatSummaryLine(), 0, 0));
			this.summaryBox.addChild(this.summaryGutter);
			this.addChild(this.summarySpacer);
			this.addChild(this.summaryRegion);
		} else {
			this.addChild(this.childrenContainer);
		}
	}
}
