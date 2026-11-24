import {
	type Color,
	type Component,
	colorToRgb,
	foregroundAnsi,
	indexedColor,
	Loader,
	mixColors,
	rgbColor,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { formatTokens } from "./footer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export const DEFAULT_WORKING_MESSAGES = [
	"Pondering",
	"Weaving",
	"Seeking",
	"Réflexion",
	"Pensando",
	"Cogitans",
	"Meditans",
	"Aether",
	"Noctis",
	"Arcana",
	"Satori",
	"Aletheia",
	"Thinking",
	"Running",
] as const;

const DEFAULT_WORKING_FRAMES = ["✦", "✧", "⋆", "·", "⋆", "✧"] as const;

function createDefaultWorkingIndicator(
	colorFn: (text: string) => string = (text) => theme.fg("accent", text),
): WorkingIndicatorOptions {
	return {
		frames: DEFAULT_WORKING_FRAMES.map(colorFn),
		intervalMs: 140,
	};
}

export function pickWorkingMessage(random: () => number = Math.random): string {
	return (
		DEFAULT_WORKING_MESSAGES[Math.floor(random() * DEFAULT_WORKING_MESSAGES.length)] ?? DEFAULT_WORKING_MESSAGES[0]
	);
}

/** Random show-off words for the end-of-turn tokens-per-second notification. */
export const DEFAULT_COOKED_MESSAGES = [
	"出锅",
	"大成",
	"圆满",
	"Served",
	"Forged",
	"Manifest",
	"Accompli",
	"Compiuto",
	"Servido",
	"Confectum",
	"Telos",
	"Siddham",
	"Kansei",
	"Zenith",
	"Omega",
] as const;

export function pickCookedMessage(random: () => number = Math.random): string {
	return DEFAULT_COOKED_MESSAGES[Math.floor(random() * DEFAULT_COOKED_MESSAGES.length)] ?? DEFAULT_COOKED_MESSAGES[0];
}

/** Random icons for the end-of-turn notification. */
export const DEFAULT_COOKED_ICONS = ["✶", "✓", "◆", "❖", "✪", "✴", "✠", "⚑", "☑"] as const;

export function pickCookedIcon(random: () => number = Math.random): string {
	return DEFAULT_COOKED_ICONS[Math.floor(random() * DEFAULT_COOKED_ICONS.length)] ?? DEFAULT_COOKED_ICONS[0];
}

export function formatElapsedTime(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = seconds % 60;
	return `${hours > 0 ? `${hours}h ` : ""}${minutes > 0 ? `${minutes}m ` : ""}${remainingSeconds}s`;
}

export function formatTtft(totalSeconds: number): string {
	return formatElapsedTime(Math.max(1, Math.round(totalSeconds)));
}

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	renderInBorder(width: number): string {
		const line = super.render(width + 2)[1] ?? "";
		return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
	}

	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}

	dispose(): void {
		this.stop();
	}
}

const SHIMMER_INTERVAL_MS = 50;
const SHIMMER_BREATH_PERIOD_MS = 2600;
const SHIMMER_OVERSCAN = 0.5;
const SHIMMER_MIN_SIGMA = 1.25;
const SHIMMER_MAX_SIGMA = 4.5;
const SHIMMER_MID_STOP = 0.25;
const SHIMMER_BOLD_THRESHOLD = 0.8;
const SHIMMER_BOLD_BREATH_THRESHOLD = 0.35;
const DARK_SHADOW_ANCHOR = rgbColor(16, 16, 20);
const BLACK_COLOR = rgbColor(0, 0, 0);
const WHITE_COLOR = rgbColor(255, 255, 255);
// Match CSI foreground SGR codes (truecolor or 256-color) produced by a border color function.
const TRUECOLOR_FG_PATTERN = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const INDEXED_FG_PATTERN = /\x1b\[38;5;(\d+)m/;

function extractColorFromColorFn(colorFn: ((text: string) => string) | undefined): Color | undefined {
	if (!colorFn) return undefined;
	const sample = colorFn("x");
	const truecolor = TRUECOLOR_FG_PATTERN.exec(sample);
	if (truecolor) {
		const r = Number(truecolor[1]);
		const g = Number(truecolor[2]);
		const b = Number(truecolor[3]);
		if (r <= 255 && g <= 255 && b <= 255) return rgbColor(r, g, b);
	}
	const indexed = INDEXED_FG_PATTERN.exec(sample);
	if (indexed) {
		const index = Number(indexed[1]);
		if (index <= 255) return indexedColor(index);
	}
	return undefined;
}

function lerpRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number): Color {
	const clamped = Math.max(0, Math.min(1, t));
	return rgbColor(
		Math.round(a.r + (b.r - a.r) * clamped),
		Math.round(a.g + (b.g - a.g) * clamped),
		Math.round(a.b + (b.b - a.b) * clamped),
	);
}

/**
 * Duration (in ms) for one single-direction shimmer sweep across a label of `length` characters.
 */
export function computeShimmerHalfPeriodMs(length: number): number {
	return Math.max(900, Math.min(2000, length * 32 + 650));
}

/**
 * Compute the ping-pong light beam center (in character indices) for a shimmer sweep
 * that glides smoothly from left to right and back again without lingering off-text.
 */
export function computeShimmerCenter(length: number, elapsedMs: number): number {
	const halfPeriodMs = computeShimmerHalfPeriodMs(length);
	const fullPeriodMs = halfPeriodMs * 2;
	const phase = (Math.max(0, elapsedMs) % fullPeriodMs) / fullPeriodMs;
	const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
	return -SHIMMER_OVERSCAN + wave * (length - 1 + SHIMMER_OVERSCAN * 2);
}

/**
 * Compute the overall breathing brightness factor in [0, 1] (0 = dim trough, 1 = bright crest)
 * layered on top of the sweeping shimmer beam.
 */
export function computeShimmerBreath(elapsedMs: number): number {
	const phase = (Math.max(0, elapsedMs) % SHIMMER_BREATH_PERIOD_MS) / SHIMMER_BREATH_PERIOD_MS;
	return 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);
}

/**
 * Render text with a smooth back-and-forth light-and-shadow shimmer band layered over
 * a continuous breathing brightness modulation in `baseColor`.
 */
export function renderShimmerText(text: string, baseColor: Color, elapsedMs: number): string {
	const characters = Array.from(text);
	if (characters.length === 0) return "";

	const isDark = theme.appearance === "dark";
	const breath = computeShimmerBreath(elapsedMs);
	const shadowColor = isDark
		? mixColors(baseColor, DARK_SHADOW_ANCHOR, 0.72 - 0.64 * breath, "srgb")
		: lerpRgb(
				colorToRgb(mixColors(baseColor, WHITE_COLOR, 0.36, "srgb")),
				colorToRgb(mixColors(baseColor, BLACK_COLOR, 0.16, "srgb")),
				breath,
			);
	const midColor = isDark
		? lerpRgb(
				colorToRgb(mixColors(baseColor, DARK_SHADOW_ANCHOR, 0.52, "srgb")),
				colorToRgb(mixColors(baseColor, WHITE_COLOR, 0.28, "srgb")),
				breath,
			)
		: lerpRgb(
				colorToRgb(mixColors(baseColor, WHITE_COLOR, 0.18, "srgb")),
				colorToRgb(mixColors(baseColor, BLACK_COLOR, 0.34, "srgb")),
				breath,
			);
	const highlightColor = isDark
		? mixColors(baseColor, WHITE_COLOR, 0.22 + 0.68 * breath, "srgb")
		: mixColors(baseColor, BLACK_COLOR, 0.22 + 0.4 * breath, "srgb");
	const midRgb = colorToRgb(midColor);
	const shadowRgb = colorToRgb(shadowColor);
	const highlightRgb = colorToRgb(highlightColor);
	const colorMode = theme.getColorMode();
	const center = computeShimmerCenter(characters.length, elapsedMs);
	const sigma = Math.max(SHIMMER_MIN_SIGMA, Math.min(SHIMMER_MAX_SIGMA, characters.length * 0.15));

	let result = "";
	let activeFg = "";
	let activeBold = false;
	for (let index = 0; index < characters.length; index++) {
		const char = characters[index]!;
		if (char === " " && activeFg.length > 0) {
			result += char;
			continue;
		}
		const distance = index - center;
		const intensity = Math.exp(-(distance * distance) / (2 * sigma * sigma));
		const color =
			intensity < SHIMMER_MID_STOP
				? lerpRgb(shadowRgb, midRgb, intensity / SHIMMER_MID_STOP)
				: lerpRgb(midRgb, highlightRgb, (intensity - SHIMMER_MID_STOP) / (1 - SHIMMER_MID_STOP));
		const fg = foregroundAnsi(color, colorMode);
		const bold = intensity >= SHIMMER_BOLD_THRESHOLD && breath >= SHIMMER_BOLD_BREATH_THRESHOLD;
		if (fg !== activeFg || bold !== activeBold) {
			if (activeBold && !bold) result += "\x1b[22m";
			if (fg !== activeFg) result += fg;
			if (!activeBold && bold) result += "\x1b[1m";
			activeFg = fg;
			activeBold = bold;
		}
		result += char;
	}
	if (activeFg.length > 0) {
		result += activeBold ? "\x1b[22;39m" : "\x1b[39m";
	}
	return result;
}

export class WorkingStatusIndicator extends StatusIndicator {
	// Rendered during super(), before subclass fields are assigned, hence `| undefined`.
	private baseMessage: string | undefined;
	private workingColorFn: ((text: string) => string) | undefined;
	private animationStartedAt: number | undefined;
	private startedAt: number | undefined;
	private outputTokens = 0;
	private detail: string | undefined;
	private elapsedInterval: NodeJS.Timeout | undefined;
	private textSweepInterval: NodeJS.Timeout | undefined;

	constructor(
		ui: TUI,
		message: string,
		indicator?: WorkingIndicatorOptions,
		colorFn?: (text: string) => string,
		progress?: { startedAt: number; outputTokens: number; detail?: string },
	) {
		super(
			"working",
			ui,
			colorFn ?? ((text) => theme.fg("accent", text)),
			colorFn ?? ((text) => theme.fg("muted", text)),
			message,
			indicator ?? createDefaultWorkingIndicator(colorFn),
		);
		this.baseMessage = message;
		this.workingColorFn = colorFn;
		this.animationStartedAt = Date.now();
		if (!indicator) this.setIndicator();
		else this.updateDisplay();
		this.textSweepInterval = setInterval(() => {
			if (this.baseMessage && this.baseMessage.length > 0) {
				this.updateDisplay();
			}
		}, SHIMMER_INTERVAL_MS);
		if (progress) {
			this.detail = progress.detail?.trim() || undefined;
			this.setProgress(progress.startedAt, progress.outputTokens);
		}
	}

	override setMessage(message: string): void {
		if (this.baseMessage === message) return;
		this.baseMessage = message;
		this.updateProgressMessage();
	}

	setDetail(detail?: string): void {
		const normalized = detail?.trim() || undefined;
		if (this.detail === normalized) return;
		this.detail = normalized;
		this.updateProgressMessage();
	}

	override setIndicator(indicator?: WorkingIndicatorOptions): void {
		super.setIndicator(indicator ?? createDefaultWorkingIndicator(this.workingColorFn));
	}

	override renderMessage(message: string): string {
		const baseColor = extractColorFromColorFn(this.workingColorFn) ?? theme.colors.accent;
		const elapsedMs = Date.now() - (this.animationStartedAt ?? Date.now());
		return renderShimmerText(message, baseColor, elapsedMs);
	}

	setProgress(startedAt: number, outputTokens: number): void {
		this.startedAt = startedAt;
		this.outputTokens = Math.max(0, Math.floor(outputTokens));
		if (!this.elapsedInterval) {
			this.elapsedInterval = setInterval(() => this.updateProgressMessage(), 1000);
		}
		this.updateProgressMessage();
	}

	private updateProgressMessage(): void {
		const baseMessage = this.baseMessage ?? "";
		if (this.startedAt === undefined) {
			super.setMessage(this.detail ? `${baseMessage} (${this.detail})` : baseMessage);
			return;
		}
		const elapsedSeconds = (Date.now() - this.startedAt) / 1000;
		const tokenUnit = this.outputTokens === 1 ? "token" : "tokens";
		const detailSuffix = this.detail ? ` · ${this.detail}` : "";
		super.setMessage(
			`${baseMessage} (${formatElapsedTime(elapsedSeconds)} · ${formatTokens(this.outputTokens)} ${tokenUnit}${detailSuffix})`,
		);
	}

	override dispose(): void {
		if (this.elapsedInterval) {
			clearInterval(this.elapsedInterval);
			this.elapsedInterval = undefined;
		}
		if (this.textSweepInterval) {
			clearInterval(this.textSweepInterval);
			this.textSweepInterval = undefined;
		}
		super.dispose();
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	// Rendered during super(), before constructor assignments land, hence `| undefined`.
	private readonly label: string | undefined;
	private readonly startedAt: number | undefined;

	constructor(ui: TUI, reason: CompactionStatusReason, colorFn?: (text: string) => string) {
		const label =
			reason === "manual"
				? "Compacting context"
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting`;
		super(
			"compaction",
			ui,
			colorFn ?? ((spinner) => theme.fg("accent", spinner)),
			colorFn ?? ((text) => theme.fg("muted", text)),
			label,
			createDefaultWorkingIndicator(colorFn),
		);
		this.label = label;
		this.startedAt = Date.now();
	}

	override renderMessage(message: string): string {
		// The first render runs inside super() before the subclass fields above are set.
		const label = this.label ?? message;
		const elapsedSeconds = (Date.now() - (this.startedAt ?? Date.now())) / 1000;
		return (
			theme.fg("muted", `${label} `) +
			this.renderBar() +
			theme.fg("dim", ` ${formatElapsedTime(elapsedSeconds)} · ${keyText("app.interrupt")} to cancel`)
		);
	}

	/**
	 * Indeterminate bar: compaction is one awaited LLM call with no streamed progress,
	 * so a filled segment sweeps back and forth instead of faking a percentage. The
	 * position derives from wall time and animates on the spinner's render interval.
	 */
	private renderBar(): string {
		const width = 12;
		const fillWidth = 4;
		const periodMs = 1500;
		const phase = ((Date.now() - (this.startedAt ?? Date.now())) % periodMs) / periodMs;
		const triangle = phase < 0.5 ? phase * 2 : 2 - phase * 2;
		const maxStart = width - fillWidth;
		const start = Math.round(triangle * maxStart);
		return (
			theme.fg("borderMuted", "░".repeat(start)) +
			theme.fg("accent", "█".repeat(fillWidth)) +
			theme.fg("borderMuted", "░".repeat(maxStart - start))
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
