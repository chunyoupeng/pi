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
	"Réflexion",
	"Pensando",
	"Cogitans",
	"Meditans",
	"Laborans",
	"Scrutans",
	"Elaborans",
	"Fabricans",
	"Speculans",
	"Deliberans",
	"Perpendens",
	"Contemplans",
	"Aletheia",
	"Thinking",
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
const SHIMMER_SIGMA = 1.6;
// About 3.75 sigma: the band's tail rounds to zero at the ends, so the pause shows the flat base color.
const SHIMMER_OVERSCAN = 6;
const SHIMMER_MS_PER_CHAR = 70;
const SHIMMER_PAUSE_MS = 600;
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
 * Duration (in ms) of one left-to-right shimmer sweep across a label of `length` characters.
 */
export function computeShimmerSweepMs(length: number): number {
	return (length - 1 + SHIMMER_OVERSCAN * 2) * SHIMMER_MS_PER_CHAR;
}

/**
 * Compute the light band center (in character indices): a constant-speed left-to-right sweep,
 * then a pause with the band parked off-text before the next sweep starts from the left.
 */
export function computeShimmerCenter(length: number, elapsedMs: number): number {
	const sweepMs = computeShimmerSweepMs(length);
	const t = Math.max(0, elapsedMs) % (sweepMs + SHIMMER_PAUSE_MS);
	const progress = Math.min(1, t / sweepMs);
	return -SHIMMER_OVERSCAN + progress * (length - 1 + SHIMMER_OVERSCAN * 2);
}

/**
 * Render text in `baseColor` with a soft highlight band sweeping from left to right.
 */
export function renderShimmerText(text: string, baseColor: Color, elapsedMs: number): string {
	const characters = Array.from(text);
	if (characters.length === 0) return "";

	const baseRgb = colorToRgb(baseColor);
	const highlightRgb = colorToRgb(
		theme.appearance === "dark"
			? mixColors(baseColor, WHITE_COLOR, 0.6, "srgb")
			: mixColors(baseColor, BLACK_COLOR, 0.45, "srgb"),
	);
	const colorMode = theme.getColorMode();
	const center = computeShimmerCenter(characters.length, elapsedMs);

	let result = "";
	let activeFg = "";
	for (let index = 0; index < characters.length; index++) {
		const char = characters[index]!;
		if (char === " " && activeFg.length > 0) {
			result += char;
			continue;
		}
		const distance = index - center;
		const intensity = Math.exp(-(distance * distance) / (2 * SHIMMER_SIGMA * SHIMMER_SIGMA));
		const fg = foregroundAnsi(lerpRgb(baseRgb, highlightRgb, intensity), colorMode);
		if (fg !== activeFg) {
			result += fg;
			activeFg = fg;
		}
		result += char;
	}
	return `${result}\x1b[39m`;
}

const BREATH_PERIOD_MS = 2000;

/**
 * Breathing brightness in [0, 1]: starts dim, peaks halfway through each period, eases at both ends.
 */
export function computeBreath(elapsedMs: number): number {
	const phase = (Math.max(0, elapsedMs) % BREATH_PERIOD_MS) / BREATH_PERIOD_MS;
	return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
}

/** Request phase shown next to the token count: `up` while the model reads the prompt, `down` while it streams output. */
export type WorkingTokenDirection = "up" | "down";

// Fraction of the remaining gap closed per shimmer tick, so the shown count rolls toward the target.
const TOKEN_EASE = 0.2;

export class WorkingStatusIndicator extends StatusIndicator {
	// Rendered during super(), before subclass fields are assigned, hence `| undefined`.
	private baseMessage: string | undefined;
	private workingColorFn: ((text: string) => string) | undefined;
	private animationStartedAt: number | undefined;
	private startedAt: number | undefined;
	private targetTokens = 0;
	private shownTokens = 0;
	private direction: WorkingTokenDirection = "down";
	private detail: string | undefined;
	private elapsedInterval: NodeJS.Timeout | undefined;
	private textSweepInterval: NodeJS.Timeout | undefined;

	constructor(
		ui: TUI,
		message: string,
		indicator?: WorkingIndicatorOptions,
		colorFn?: (text: string) => string,
		progress?: { startedAt: number; tokens: number; direction: WorkingTokenDirection; detail?: string },
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
			if (this.stepShownTokens()) this.updateProgressMessage();
			else if (this.baseMessage && this.baseMessage.length > 0) this.updateDisplay();
		}, SHIMMER_INTERVAL_MS);
		if (progress) {
			this.detail = progress.detail?.trim() || undefined;
			this.setProgress(progress.startedAt, progress.tokens, progress.direction);
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
		// Only the label shimmers; the progress suffix already changes every second and stays static.
		const label = this.baseMessage && message.startsWith(this.baseMessage) ? this.baseMessage : message;
		const suffix = message.slice(label.length);
		const shimmer = renderShimmerText(label, baseColor, elapsedMs);
		// The detail (e.g. "still thinking") breathes, so a long silent think still reads as alive.
		const detailStart = this.detail ? suffix.lastIndexOf(this.detail) : -1;
		if (!this.detail || detailStart < 0) return shimmer + (suffix ? theme.fg("dim", suffix) : "");
		const breath = computeBreath(elapsedMs);
		const detailFg = foregroundAnsi(
			lerpRgb(colorToRgb(theme.colors.dim), colorToRgb(baseColor), breath),
			theme.getColorMode(),
		);
		return (
			shimmer +
			theme.fg("dim", suffix.slice(0, detailStart)) +
			`${detailFg}${this.detail}\x1b[39m` +
			theme.fg("dim", suffix.slice(detailStart + this.detail.length))
		);
	}

	/** Show `tokens` for the `direction` phase; the shown count rolls toward it, and snaps when the phase changes. */
	setProgress(startedAt: number, tokens: number, direction: WorkingTokenDirection): void {
		const target = Math.max(0, Math.floor(tokens));
		// Rolling from a 50k prompt down to a fresh output count would read as a countdown.
		if (this.startedAt === undefined || direction !== this.direction) this.shownTokens = target;
		this.startedAt = startedAt;
		this.targetTokens = target;
		this.direction = direction;
		if (!this.elapsedInterval) {
			this.elapsedInterval = setInterval(() => this.updateProgressMessage(), 1000);
		}
		this.updateProgressMessage();
	}

	private stepShownTokens(): boolean {
		const gap = this.targetTokens - this.shownTokens;
		if (gap === 0) return false;
		this.shownTokens += Math.sign(gap) * Math.ceil(Math.abs(gap) * TOKEN_EASE);
		return true;
	}

	private updateProgressMessage(): void {
		const baseMessage = this.baseMessage ?? "";
		if (this.startedAt === undefined) {
			super.setMessage(this.detail ? `${baseMessage} (${this.detail})` : baseMessage);
			return;
		}
		const elapsedSeconds = (Date.now() - this.startedAt) / 1000;
		const arrow = this.direction === "up" ? "↑" : "↓";
		const tokenUnit = this.shownTokens === 1 ? "token" : "tokens";
		const detailSuffix = this.detail ? ` · ${this.detail}` : "";
		super.setMessage(
			`${baseMessage} (${formatElapsedTime(elapsedSeconds)} · ${arrow} ${formatTokens(this.shownTokens)} ${tokenUnit}${detailSuffix})`,
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
