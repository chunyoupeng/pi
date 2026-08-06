import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { formatCollapsedOutput, formatToolCallHeader } from "../src/core/tools/render-utils.ts";
import {
	AssistantMessageComponent,
	estimateAssistantOutputTokens,
} from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fakeAssistant(
	partial: Partial<AssistantMessage> & { content: AssistantMessage["content"] },
): AssistantMessage {
	const { content, usage, stopReason, ...rest } = partial;
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: stopReason ?? "stop",
		timestamp: Date.now(),
		...rest,
	} as AssistantMessage;
}

describe("claude-style tool formatting", () => {
	initTheme("dark");

	test("formatToolCallHeader wraps Name(args)", () => {
		expect(stripAnsi(formatToolCallHeader("Bash", "echo hi", theme))).toBe("Bash(echo hi)");
	});

	test("formatCollapsedOutput shows 3 lines, omit count, and summary", () => {
		const body = formatCollapsedOutput("a\nb\nc\nd\ne", theme, {
			maxLines: 3,
			summary: theme.fg("muted", "5 stdout"),
		});
		const plain = stripAnsi(body);
		expect(plain).toContain("a\nb\nc");
		expect(plain).toContain("... 2");
		expect(plain).toContain("5 stdout");
		expect(plain.split("\n")).not.toContain("d");
		expect(plain.split("\n")).not.toContain("e");
	});
});

describe("assistant thinking and token estimate", () => {
	initTheme("dark");

	test("hides thinking body by default", () => {
		const component = new AssistantMessageComponent(
			fakeAssistant({
				content: [
					{ type: "thinking", thinking: "secret plan" },
					{ type: "text", text: "hello" },
				],
			}),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("hello");
		expect(rendered).not.toContain("secret plan");
		expect(rendered).not.toContain("Thinking...");
	});

	test("estimateAssistantOutputTokens prefers usage.output then chars/4", () => {
		expect(
			estimateAssistantOutputTokens(
				fakeAssistant({
					content: [{ type: "text", text: "abcd" }],
					usage: {
						input: 0,
						output: 42,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 42,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			),
		).toBe(42);

		expect(
			estimateAssistantOutputTokens(
				fakeAssistant({
					content: [{ type: "text", text: "abcd" }],
				}),
			),
		).toBe(1);
	});
});
