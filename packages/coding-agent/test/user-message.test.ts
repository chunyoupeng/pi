import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("renders user message without full background block and with accent ❯ prefix", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		// Single line - no excessive vertical padding
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(theme.fg("accent", "❯"));
		expect(lines[0]).not.toContain(BG_RESET);
		expect(stripAnsi(lines[0])).toMatch(/^ ❯ hello/);

		// OSC markers at start of line, off line end
		expect(lines[0].startsWith(OSC133_ZONE_START + OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("aligns continuation lines with message text on multi-line messages", () => {
		initTheme("dark");

		const component = new UserMessageComponent("first line\nsecond line\nthird line");
		const lines = component.render(40);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(theme.fg("accent", "❯"));
		expect(lines[0]).not.toContain(BG_RESET);
		expect(stripAnsi(lines[0])).toMatch(/^ ❯ first line/);
		expect(stripAnsi(lines[1])).toMatch(/^ {3}second line/);
		expect(stripAnsi(lines[2])).toMatch(/^ {3}third line/);

		// OSC markers on multi-line messages
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("aligns wrapped continuation lines with message text", () => {
		initTheme("dark");

		const component = new UserMessageComponent("A long message that wraps across lines when rendered narrow");
		const lines = component.render(25);

		expect(lines.length).toBeGreaterThan(1);
		expect(stripAnsi(lines[0])).toMatch(/^ ❯ /);
		for (let i = 1; i < lines.length; i++) {
			expect(stripAnsi(lines[i])).toMatch(/^ {3}/);
		}
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 76 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});
});
