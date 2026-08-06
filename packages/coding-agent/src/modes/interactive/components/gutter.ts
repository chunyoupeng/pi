import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";

export interface GutterOptions {
	/** Visible width of the gutter column, in cells. */
	width: number;
	/** Marker for the first line, e.g. a status bullet. Re-read on every render. */
	marker: () => string;
}

/**
 * Renders a child in a content column with a fixed-width marker column beside it.
 *
 * Wrapped lines are indented to the content column rather than falling back to
 * the left edge, so a long line stays visually attached to the entry it belongs
 * to instead of reading as a new one.
 */
export class Gutter implements Component {
	private child: Component | undefined;
	private readonly gutterWidth: number;
	private readonly marker: () => string;

	constructor(options: GutterOptions, child?: Component) {
		this.gutterWidth = Math.max(1, options.width);
		this.marker = options.marker;
		this.child = child;
	}

	setChild(child: Component | undefined): void {
		this.child = child;
	}

	invalidate(): void {
		this.child?.invalidate?.();
	}

	render(width: number): string[] {
		if (!this.child) {
			return [];
		}
		const contentWidth = Math.max(1, width - this.gutterWidth);
		const lines = this.child.render(contentWidth);

		// Renderers pad their output with leading blank lines to separate it from
		// whatever came before. The gutter supplies that separation structurally, and
		// a marker stranded on a blank line would point at nothing.
		// Rendered lines are padded out to the full width, so "blank" means blank
		// once styling and that padding are discounted.
		const start = lines.findIndex((line) => stripAnsi(line).trim().length > 0);
		if (start === -1) {
			return [];
		}

		const indent = " ".repeat(this.gutterWidth);
		const marker = this.marker();
		const firstPrefix = marker + " ".repeat(Math.max(0, this.gutterWidth - visibleWidth(marker)));

		return lines.slice(start).map((line, index) => (index === 0 ? firstPrefix : indent) + line);
	}
}
