import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { formatCollapsedOutput, formatToolCallHeader } from "../src/core/tools/render-utils.ts";
import {
	AssistantMessageComponent,
	estimateAssistantOutputTokens,
} from "../src/modes/interactive/components/assistant-message.ts";
import { Gutter } from "../src/modes/interactive/components/gutter.ts";
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
		expect(plain).toContain("… +2 lines");
		expect(plain).toContain("5 stdout");
		expect(plain.split("\n")).not.toContain("d");
		expect(plain.split("\n")).not.toContain("e");
	});

	test("formatCollapsedOutput folds by visual lines when given a width", () => {
		const wrapping = "x".repeat(30);
		const body = formatCollapsedOutput([wrapping, "b", "c", "d"].join("\n"), theme, {
			maxLines: 3,
			width: 20,
			styleLine: (line) => line,
		});
		const lines = stripAnsi(body).split("\n");
		// The first logical line wraps to two rows, so the preview is xxx / xxx / b.
		expect(lines.length).toBe(4);
		expect(lines[3]).toContain("… +2 lines");
		expect(lines.slice(0, 3).join("")).not.toContain("c");
	});

	test("formatCollapsedOutput renders in full rather than hiding a single line", () => {
		const body = formatCollapsedOutput("a\nb\nc\nd", theme, { maxLines: 3, width: 40 });
		const plain = stripAnsi(body);
		expect(plain).toBe("a\nb\nc\nd");
		expect(plain).not.toContain("+1 line");
	});

	test("keeps the tail when fromEnd is set, with the hint above the kept lines", () => {
		const body = formatCollapsedOutput("a\nb\nc\nd\ne", theme, { maxLines: 3, width: 40, fromEnd: true });
		const lines = stripAnsi(body).split("\n");
		expect(lines[0]).toContain("… +2 lines");
		expect(lines.slice(1)).toEqual(["c", "d", "e"]);
	});
});

describe("gutter layout", () => {
	initTheme("dark");

	const child = (lines: string[]) => ({ render: () => lines });

	test("marks the first line and hangs the rest under the content column", () => {
		const gutter = new Gutter({ width: 5, marker: () => "  ⎿" }, child(["first", "second", "third"]));
		expect(gutter.render(40)).toEqual(["  ⎿  first", "     second", "     third"]);
	});

	test("narrows the child to leave room for the gutter", () => {
		let seen = 0;
		const gutter = new Gutter(
			{ width: 2, marker: () => "⏺" },
			{
				render: (width: number) => {
					seen = width;
					return ["x"];
				},
			},
		);
		gutter.render(40);
		expect(seen).toBe(38);
	});

	test("puts the marker on the first line with content, not on padding", () => {
		const gutter = new Gutter({ width: 2, marker: () => "⏺" }, child(["    ", "content"]));
		expect(gutter.render(40)).toEqual(["⏺ content"]);
	});

	test("renders nothing when the child has nothing to show", () => {
		expect(new Gutter({ width: 2, marker: () => "⏺" }, child([])).render(40)).toEqual([]);
		expect(new Gutter({ width: 2, marker: () => "⏺" }, child(["  ", ""])).render(40)).toEqual([]);
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
