import type { Box, TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 80;

function renderText(component: Box): string {
	return stripAnsi(component.render(WIDTH).join("\n"));
}

function clickRow(component: Box, marker: string): void {
	const lines = component.render(WIDTH);
	const row = lines.findIndex((line) => stripAnsi(line).includes(marker));
	expect(row).toBeGreaterThanOrEqual(0);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y: row,
		screenX: 2,
		screenY: row,
		width: WIDTH,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(component.handleMouse(event)?.handled).toBe(true);
}

describe("collapsible message components", () => {
	beforeAll(() => initTheme("dark"));

	test("toggles a compaction summary when clicked", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "compaction details",
			tokensBefore: 1234,
			timestamp: Date.now(),
		});

		expect(renderText(component)).not.toContain("compaction details");
		clickRow(component, "Conversation compacted");
		expect(renderText(component)).toContain("compaction details");
		clickRow(component, "Conversation compacted");
		expect(renderText(component)).not.toContain("compaction details");
	});

	test("renders a compaction summary with a status bullet gutter and token details", () => {
		const component = new CompactionSummaryMessageComponent(
			{
				role: "compactionSummary",
				summary: "first line\nsecond line",
				tokensBefore: 1234,
				timestamp: Date.now(),
			},
			undefined,
			1,
		);

		const collapsedLines = component.render(80).map((line) => stripAnsi(line));
		expect(collapsedLines[0]).toMatch(/^ ⏺ Conversation compacted \(1,234 → ~\d+ tokens · .* to expand\)/);

		component.setExpanded(true);
		const expandedLines = component.render(80).map((line) => stripAnsi(line));
		expect(expandedLines[0]).toMatch(/^ ⏺ Conversation compacted \(1,234 → ~\d+ tokens\)/);
		expect(expandedLines.some((line) => line.includes("first line"))).toBe(true);
		expect(expandedLines.some((line) => line.includes("second line"))).toBe(true);
	});

	test("toggles a branch summary when clicked", () => {
		const component = new BranchSummaryMessageComponent({
			role: "branchSummary",
			summary: "branch details",
			fromId: "entry-1",
			timestamp: Date.now(),
		});

		expect(renderText(component)).not.toContain("branch details");
		clickRow(component, "[branch]");
		expect(renderText(component)).toContain("branch details");
		clickRow(component, "[branch]");
		expect(renderText(component)).not.toContain("branch details");
	});

	test("toggles a skill invocation when clicked", () => {
		const component = new SkillInvocationMessageComponent({
			name: "example-skill",
			location: "/tmp/example-skill.md",
			content: "skill details",
			userMessage: undefined,
		});

		expect(renderText(component)).not.toContain("skill details");
		clickRow(component, "[skill]");
		expect(renderText(component)).toContain("skill details");
		clickRow(component, "[skill]");
		expect(renderText(component)).not.toContain("skill details");
	});
});
