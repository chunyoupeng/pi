import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private paddingX: number | (() => number);

	constructor(
		color: (str: string) => string = (str) => theme.fg("border", str),
		paddingX: number | (() => number) = 0,
	) {
		this.color = color;
		this.paddingX = paddingX;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const requestedPad = Math.max(0, typeof this.paddingX === "function" ? this.paddingX() : this.paddingX);
		const pad = Math.min(requestedPad, Math.floor(Math.max(0, width - 1) / 2));
		const lineWidth = Math.max(1, width - pad * 2);
		return [`${" ".repeat(pad)}${this.color("─".repeat(lineWidth))}`];
	}
}
