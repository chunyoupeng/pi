import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	computeShimmerCenter,
	computeShimmerSweepMs,
	DEFAULT_WORKING_MESSAGES,
	formatElapsedTime,
	IdleStatus,
	pickWorkingMessage,
	RetryStatusIndicator,
	renderShimmerText,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as standalone status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("picks a working message of at least 8 characters for each run", () => {
		expect(pickWorkingMessage(() => 0)).toBe(DEFAULT_WORKING_MESSAGES[0]);
		expect(pickWorkingMessage(() => 0.999)).toBe(DEFAULT_WORKING_MESSAGES.at(-1));
		expect(DEFAULT_WORKING_MESSAGES.every((message) => !message.includes(" "))).toBe(true);
		expect(DEFAULT_WORKING_MESSAGES.every((message) => Array.from(message).length >= 8)).toBe(true);
	});

	it("formats elapsed time with compact hour, minute, and second units", () => {
		expect(formatElapsedTime(0)).toBe("0s");
		expect(formatElapsedTime(59.9)).toBe("59s");
		expect(formatElapsedTime(80)).toBe("1m 20s");
		expect(formatElapsedTime(7507)).toBe("2h 5m 7s");
	});

	it("animates the default working icon", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Cogitans");

		expect(indicator.render(80).join("\n")).toContain("✦");
		vi.advanceTimersByTime(140);
		expect(indicator.render(80).join("\n")).toContain("✧");

		indicator.dispose();
	});

	it("updates working elapsed time and output tokens", () => {
		initTheme("dark");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Working...", undefined, undefined, {
			startedAt: Date.now(),
			tokens: 1234,
			direction: "down",
		});

		expect(stripAnsi(indicator.render(80).join("\n"))).toContain("Working... (0s · ↓ 1.2k tokens)");
		vi.advanceTimersByTime(3000);
		expect(stripAnsi(indicator.render(80).join("\n"))).toContain("Working... (3s · ↓ 1.2k tokens)");

		indicator.setDetail("still thinking with high effort");
		const fullWithDetail = indicator.render(100)[1]!;
		expect(stripAnsi(fullWithDetail)).toContain("Working... (3s · ↓ 1.2k tokens · still thinking with high effort)");
		// Only the label shimmers; the progress stays static dim text while the thinking detail breathes.
		expect(fullWithDetail).toContain(theme.fg("dim", " (3s · ↓ 1.2k tokens · "));
		const detailShade = (line: string) => /(\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m)still thinking/.exec(line)?.[1];
		// 3s in, the 2s breath is at its crest; one second later it is at its trough.
		const crestShade = detailShade(fullWithDetail);
		vi.advanceTimersByTime(1000);
		const troughShade = detailShade(indicator.render(100)[1]!);
		expect(crestShade).toBeDefined();
		expect(troughShade).toBeDefined();
		expect(troughShade).not.toBe(crestShade);
		expect(stripAnsi(indicator.render(100)[1]!)).toContain("(4s · ↓ 1.2k tokens · still thinking with high effort)");

		indicator.setDetail(undefined);
		expect(stripAnsi(indicator.render(100).join("\n"))).toContain("Working... (4s · ↓ 1.2k tokens)");
		expect(stripAnsi(indicator.render(100).join("\n"))).not.toContain("still thinking");

		const callsBeforeDispose = vi.mocked(tui.requestRender).mock.calls.length;
		indicator.dispose();
		vi.advanceTimersByTime(2000);
		expect(tui.requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});

	it("rolls the token count toward its target and snaps when the phase changes", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Working", undefined, undefined, {
			startedAt: Date.now(),
			tokens: 52_000,
			direction: "up",
		});
		const label = () => stripAnsi(indicator.render(80)[1]!);
		expect(label()).toContain("↑ 52k tokens");

		// First output token: switch to the download phase without counting down from the prompt size.
		indicator.setProgress(Date.now(), 100, "down");
		expect(label()).toContain("↓ 100 tokens");

		indicator.setProgress(Date.now(), 2000, "down");
		expect(label()).toContain("↓ 100 tokens");
		vi.advanceTimersByTime(50);
		expect(label()).not.toContain("↓ 100 tokens");
		expect(label()).not.toContain("↓ 2.0k tokens");
		vi.advanceTimersByTime(2000);
		expect(label()).toContain("↓ 2.0k tokens");

		indicator.dispose();
	});

	it("keeps the top border unchanged unless the editor opts in", () => {
		initTheme("dark");
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);

		expect(stripAnsi(editor.render(20)[0]!)).toBe("─".repeat(20));
		const standaloneLine = indicator.render(20)[1]!;
		expect(standaloneLine).toContain(theme.getFgAnsi("accent"));
		expect(stripAnsi(standaloneLine)).toContain("Working");
		indicator.dispose();
	});

	it("embeds the working indicator with a sweeping shimmer when the editor opts in", () => {
		initTheme("dark");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		expect(editor.embedWorkingStatus).toBe(true);
		editor.borderColor = theme.getThinkingBorderColor("high");
		const indicator = new WorkingStatusIndicator(tui, "Still thinking with high effort", undefined, (text) =>
			editor.borderColor(text),
		);
		editor.setWorkingStatusIndicator(indicator);

		const frame0 = editor.render(45)[0]!;
		expect(stripAnsi(frame0)).toBe("── ✦ Still thinking with high effort ────────");
		expect(visibleWidth(frame0)).toBe(45);
		// Border prefix, spinner, and border suffix still use the thinking border color.
		expect(frame0.split(theme.getFgAnsi("thinkingHigh")).length).toBeGreaterThanOrEqual(4);

		// Advancing time sweeps the light-and-shadow shimmer across the label (not flat static text).
		vi.advanceTimersByTime(600);
		const frameMid = editor.render(45)[0]!;
		expect(stripAnsi(frameMid)).toContain("Still thinking with high effort");
		expect(visibleWidth(frameMid)).toBe(45);
		expect(frameMid).not.toBe(frame0);
		// Multiple distinct foreground ANSI shades appear across the shimmering phrase.
		const shades = new Set(frameMid.match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g) ?? []);
		expect(shades.size).toBeGreaterThan(2);

		indicator.dispose();
	});

	it("sweeps the shimmer left to right at constant speed, then pauses off-text", () => {
		initTheme("dark");
		const text = "Still thinking with high effort";
		const length = text.length;
		const sweep = computeShimmerSweepMs(length);
		const start = computeShimmerCenter(length, 0);
		const quarter = computeShimmerCenter(length, sweep / 4);
		const half = computeShimmerCenter(length, sweep / 2);
		const end = computeShimmerCenter(length, sweep);
		const paused = computeShimmerCenter(length, sweep + 500);

		expect(start).toBeLessThan(-2);
		expect(half - quarter).toBeCloseTo(quarter - start, 5);
		expect(end).toBeGreaterThan(length + 1);
		expect(paused).toBeCloseTo(end, 5);

		// During the pause the label is one flat base color without bold.
		const flat = renderShimmerText(text, theme.colors.thinkingHigh, sweep + 500);
		expect(new Set(flat.match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g) ?? []).size).toBe(1);
		expect(flat).not.toContain("\x1b[1m");

		// Mid-sweep, short labels show distinct shades across the word.
		const shortRendered = renderShimmerText("Running", theme.colors.thinkingXhigh, computeShimmerSweepMs(7) / 2);
		const shortShades = new Set(shortRendered.match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g) ?? []);
		expect(shortShades.size).toBeGreaterThan(2);
	});

	it("embeds compaction, summary, and retry labels within the border width", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		const indicators = [
			new CompactionStatusIndicator(tui, "manual"),
			new CompactionStatusIndicator(tui, "threshold"),
			new CompactionStatusIndicator(tui, "overflow"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 3000),
		];
		try {
			for (const indicator of indicators) {
				editor.setWorkingStatusIndicator(indicator);
				const label = stripAnsi(indicator.render(120)[1]!).trim();
				expect(stripAnsi(editor.render(120)[0]!)).toContain(`── ${label} `);
				for (const width of [1, 4, 10, 20, 80, 120]) {
					expect(visibleWidth(editor.render(width)[0]!)).toBe(width);
				}
			}
			vi.advanceTimersByTime(1000);
			expect(stripAnsi(editor.render(120)[0]!)).toContain("Retrying (1/3) in 2s");
			editor.setWorkingStatusIndicator(undefined);
			expect(stripAnsi(editor.render(120)[0]!)).toBe("─".repeat(120));
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
