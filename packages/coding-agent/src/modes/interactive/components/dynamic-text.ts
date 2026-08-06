import { Text } from "@earendil-works/pi-tui";

/**
 * Text whose content depends on the width it is rendered at.
 *
 * Tool renderers build their output as a string before the layout width is
 * known, which makes it impossible to fold a preview by visual lines. This defers
 * the build until render time and rebuilds whenever the width changes.
 */
export class DynamicText extends Text {
	private build: (width: number) => string = () => "";
	private builtWidth: number | undefined;
	private builtText: string | undefined;

	constructor(build?: (width: number) => string, paddingX: number = 0, paddingY: number = 0) {
		super("", paddingX, paddingY);
		if (build) {
			this.build = build;
		}
	}

	setBuilder(build: (width: number) => string): void {
		this.build = build;
		this.builtWidth = undefined;
	}

	override invalidate(): void {
		this.builtWidth = undefined;
		super.invalidate();
	}

	override render(width: number): string[] {
		if (this.builtWidth !== width) {
			const text = this.build(width);
			// setText drops Text's own render cache, so only push real changes.
			if (text !== this.builtText) {
				this.builtText = text;
				this.setText(text);
			}
			this.builtWidth = width;
		}
		return super.render(width);
	}
}
