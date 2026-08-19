import { type Component, Loader, type TUI } from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { formatTokens } from "./footer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export const DEFAULT_WORKING_MESSAGES = [
	"思考中",
	"推演中",
	"酝酿中",
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
] as const;

const DEFAULT_WORKING_FRAMES = ["✦", "✧", "⋆", "·", "⋆", "✧"] as const;

function createDefaultWorkingIndicator(): WorkingIndicatorOptions {
	return {
		frames: DEFAULT_WORKING_FRAMES.map((frame) => theme.fg("accent", frame)),
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

export function formatElapsedTime(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = seconds % 60;
	return `${hours > 0 ? `${hours}h` : ""}${minutes > 0 ? `${minutes}m` : ""}${remainingSeconds}s`;
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

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	private baseMessage: string;
	private startedAt: number | undefined;
	private outputTokens = 0;
	private elapsedInterval: NodeJS.Timeout | undefined;

	constructor(
		ui: TUI,
		message: string,
		indicator?: WorkingIndicatorOptions,
		progress?: { startedAt: number; outputTokens: number },
	) {
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator ?? createDefaultWorkingIndicator(),
		);
		this.baseMessage = message;
		if (progress) {
			this.setProgress(progress.startedAt, progress.outputTokens);
		}
	}

	override setMessage(message: string): void {
		this.baseMessage = message;
		this.updateProgressMessage();
	}

	override setIndicator(indicator?: WorkingIndicatorOptions): void {
		super.setIndicator(indicator ?? createDefaultWorkingIndicator());
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
		if (this.startedAt === undefined) {
			super.setMessage(this.baseMessage);
			return;
		}
		const elapsedSeconds = (Date.now() - this.startedAt) / 1000;
		const tokenUnit = this.outputTokens === 1 ? "token" : "tokens";
		super.setMessage(
			`${this.baseMessage} (${formatElapsedTime(elapsedSeconds)} · ${formatTokens(this.outputTokens)} ${tokenUnit})`,
		);
	}

	override dispose(): void {
		if (this.elapsedInterval) {
			clearInterval(this.elapsedInterval);
			this.elapsedInterval = undefined;
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
	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
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
