import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	computeShimmerBreath,
	computeShimmerCenter,
	computeShimmerHalfPeriodMs,
	DEFAULT_WORKING_MESSAGES,
	formatElapsedTime,
	formatTtft,
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

	it("picks a short working message for each run", () => {
		expect(pickWorkingMessage(() => 0)).toBe(DEFAULT_WORKING_MESSAGES[0]);
		expect(pickWorkingMessage(() => 0.999)).toBe(DEFAULT_WORKING_MESSAGES.at(-1));
		expect(DEFAULT_WORKING_MESSAGES.every((message) => !message.includes(" "))).toBe(true);
	});

	it("formats elapsed time with compact hour, minute, and second units", () => {
		expect(formatElapsedTime(0)).toBe("0s");
		expect(formatElapsedTime(59.9)).toBe("59s");
		expect(formatElapsedTime(80)).toBe("1m 20s");
		expect(formatElapsedTime(7507)).toBe("2h 5m 7s");
	});

	it("formats TTFT to whole seconds with sub-second values clamped to 1s", () => {
		expect(formatTtft(0)).toBe("1s");
		expect(formatTtft(0.2)).toBe("1s");
		expect(formatTtft(0.8)).toBe("1s");
		expect(formatTtft(3.24)).toBe("3s");
		expect(formatTtft(59.6)).toBe("1m 0s");
		expect(formatTtft(72.4)).toBe("1m 12s");
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
			outputTokens: 1234,
		});

		expect(stripAnsi(indicator.render(80).join("\n"))).toContain("Working... (0s · 1.2k tokens)");
		vi.advanceTimersByTime(3000);
		expect(stripAnsi(indicator.render(80).join("\n"))).toContain("Working... (3s · 1.2k tokens)");

		indicator.setDetail("still thinking with high effort");
		const fullWithDetail = indicator.render(100)[1]!;
		expect(stripAnsi(fullWithDetail)).toContain("Working... (3s · 1.2k tokens · still thinking with high effort)");
		// Shimmer sweeps across the entire text including the parenthetical progress and thinking detail.
		const suffixStart = fullWithDetail.indexOf("(");
		expect(suffixStart).toBeGreaterThan(0);
		const suffixShades = new Set(fullWithDetail.slice(suffixStart).match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g) ?? []);
		expect(suffixShades.size).toBeGreaterThan(2);

		indicator.setDetail(undefined);
		expect(stripAnsi(indicator.render(100).join("\n"))).toContain("Working... (3s · 1.2k tokens)");
		expect(stripAnsi(indicator.render(100).join("\n"))).not.toContain("still thinking");

		const callsBeforeDispose = vi.mocked(tui.requestRender).mock.calls.length;
		indicator.dispose();
		vi.advanceTimersByTime(2000);
		expect(tui.requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
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

	it("sweeps shimmer center back and forth and breathes overall brightness", () => {
		initTheme("dark");
		const text = "Still thinking with high effort";
		const length = text.length;
		const half = computeShimmerHalfPeriodMs(length);
		const start = computeShimmerCenter(length, 0);
		const quarter = computeShimmerCenter(length, half / 2);
		const rightPeak = computeShimmerCenter(length, half);
		const returnSweep = computeShimmerCenter(length, half * 1.5);
		const cycleEnd = computeShimmerCenter(length, half * 2);

		expect(start).toBeLessThan(0);
		expect(start).toBeGreaterThan(-1);
		expect(quarter).toBeGreaterThan(start);
		expect(rightPeak).toBeGreaterThan(length - 1);
		expect(rightPeak).toBeLessThan(length);
		expect(returnSweep).toBeLessThan(rightPeak);
		expect(cycleEnd).toBeCloseTo(start, 5);

		// Breathing brightness oscillates smoothly from bright crest (1) down to dim trough (0) and back.
		expect(computeShimmerBreath(0)).toBeCloseTo(1, 5);
		expect(computeShimmerBreath(1300)).toBeCloseTo(0, 5);
		expect(computeShimmerBreath(2600)).toBeCloseTo(1, 5);

		// Same shimmer position at different breathing phases produces noticeably different overall brightness,
		// and dim trough softens bold emphasis while bright crest gleams bold.
		const averageRgbLuma = (rendered: string): number => {
			const matches = [...rendered.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
			expect(matches.length).toBeGreaterThan(0);
			const sum = matches.reduce(
				(acc, m) => acc + 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]),
				0,
			);
			return sum / matches.length;
		};

		const bright = renderShimmerText(text, theme.colors.thinkingHigh, 0);
		const dim = renderShimmerText(text, theme.colors.thinkingHigh, 1300);
		expect(bright).not.toBe(dim);
		expect(averageRgbLuma(bright) - averageRgbLuma(dim)).toBeGreaterThan(45);
		expect(bright).toContain("\x1b[1m");
		expect(dim).not.toContain("\x1b[1m");

		// Short working labels also keep distinct shimmer shades across the word.
		const shortRendered = renderShimmerText("Running", theme.colors.thinkingXhigh, 0);
		const shortShades = new Set(shortRendered.match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g) ?? []);
		expect(shortShades.size).toBeGreaterThan(2);

		// Light mode also breathes noticeably between soft dim trough and vivid bright crest.
		initTheme("light");
		const lightBright = renderShimmerText(text, theme.colors.thinkingHigh, 0);
		const lightDim = renderShimmerText(text, theme.colors.thinkingHigh, 1300);
		expect(averageRgbLuma(lightDim) - averageRgbLuma(lightBright)).toBeGreaterThan(35);
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
