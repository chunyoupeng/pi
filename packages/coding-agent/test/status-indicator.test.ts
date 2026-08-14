import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_WORKING_MESSAGES,
	formatElapsedTime,
	IdleStatus,
	pickWorkingMessage,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as status indicators", () => {
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
		expect(formatElapsedTime(80)).toBe("1m20s");
		expect(formatElapsedTime(7507)).toBe("2h5m7s");
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
		const indicator = new WorkingStatusIndicator(tui, "Working...", undefined, {
			startedAt: Date.now(),
			outputTokens: 1234,
		});

		expect(indicator.render(80).join("\n")).toContain("Working... (0s · 1.2k tokens)");
		vi.advanceTimersByTime(3000);
		expect(indicator.render(80).join("\n")).toContain("Working... (3s · 1.2k tokens)");

		const callsBeforeDispose = vi.mocked(tui.requestRender).mock.calls.length;
		indicator.dispose();
		vi.advanceTimersByTime(2000);
		expect(tui.requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
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
