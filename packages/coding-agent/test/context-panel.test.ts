import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import {
	buildContextBreakdown,
	type ContextData,
	ContextPanelComponent,
} from "../src/modes/interactive/components/context-panel.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("context panel", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("builds context breakdown from an agent session with distinct colors for each category", async () => {
		harness = await createHarness();
		const data = buildContextBreakdown(harness.session);

		expect(data.categories.length).toBeGreaterThanOrEqual(6);
		const categoryIds = data.categories.map((c) => c.id);
		expect(categoryIds).toContain("system");
		expect(categoryIds).toContain("skills");
		expect(categoryIds).toContain("tools");
		expect(categoryIds).toContain("user");
		expect(categoryIds).toContain("assistant");
		expect(categoryIds).toContain("toolResults");

		// Verify distinct colors
		const colors = data.categories.map((c) => c.color);
		const uniqueColors = new Set(colors);
		expect(uniqueColors.size).toBe(colors.length);

		// Check specific assigned colors
		expect(data.categories.find((c) => c.id === "system")?.color).toBe("syntaxType");
		expect(data.categories.find((c) => c.id === "skills")?.color).toBe("syntaxVariable");
		expect(data.categories.find((c) => c.id === "tools")?.color).toBe("customMessageLabel");
		expect(data.categories.find((c) => c.id === "user")?.color).toBe("success");
		expect(data.categories.find((c) => c.id === "assistant")?.color).toBe("warning");
		expect(data.categories.find((c) => c.id === "toolResults")?.color).toBe("syntaxString");
	});

	it("renders panel header, usage stats, and category rows", () => {
		const mockData: ContextData = {
			modelName: "test-model",
			provider: "test-provider",
			contextWindow: 100000,
			totalTokens: 5000,
			percentOfWindow: 5.0,
			categories: [
				{
					id: "system",
					name: "System Prompt",
					color: "syntaxType",
					tokens: 2000,
					percentage: 40.0,
					summary: "Base guidelines",
					details: [{ label: "Base Instructions", tokens: 2000, description: "System rules" }],
				},
				{
					id: "tools",
					name: "Tools",
					color: "customMessageLabel",
					tokens: 1500,
					percentage: 30.0,
					summary: "3 active tools",
					details: [
						{ label: "read", tokens: 500, description: "Read files" },
						{ label: "bash", tokens: 500, description: "Run shell commands" },
						{ label: "edit", tokens: 500, description: "Edit files" },
					],
				},
				{
					id: "user",
					name: "User Messages",
					color: "success",
					tokens: 1500,
					percentage: 30.0,
					summary: "1 message",
					details: [{ label: "Turn #1", tokens: 1500, description: "Hello" }],
				},
			],
		};

		let closed = false;
		const panel = new ContextPanelComponent(mockData, () => {
			closed = true;
		});

		const rendered = panel.render(80).map((l) => stripAnsi(l));
		const text = rendered.join("\n");

		expect(text).toContain("Context Usage");
		expect(text).toContain("test-model (test-provider)");
		expect(text).toContain("5,000 / 100,000 tokens (5.0%)");
		expect(text).toContain("System Prompt");
		expect(text).toContain("Tools");
		expect(text).toContain("User Messages");
		expect(text).toContain("Base Instructions");

		// Test navigation
		expect(panel.getSelectedIndex()).toBe(0);
		panel.handleInput("\x1b[B"); // Down arrow
		expect(panel.getSelectedIndex()).toBe(1);

		const renderedAfterNav = panel.render(80).map((l) => stripAnsi(l));
		const textAfterNav = renderedAfterNav.join("\n");
		expect(textAfterNav).toContain("read");
		expect(textAfterNav).toContain("bash");

		// Test cancel / close via Escape
		panel.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	it("closes panel on q or Enter", () => {
		const mockData: ContextData = {
			modelName: "test-model",
			provider: "test-provider",
			contextWindow: 100000,
			totalTokens: 100,
			percentOfWindow: 0.1,
			categories: [],
		};

		let closeCount = 0;
		const panel = new ContextPanelComponent(mockData, () => {
			closeCount++;
		});

		panel.handleInput("q");
		expect(closeCount).toBe(1);

		panel.handleInput("\r");
		expect(closeCount).toBe(2);
	});

	it("registers context command in BUILTIN_SLASH_COMMANDS", () => {
		const contextCommand = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.name === "context");
		expect(contextCommand).toBeDefined();
		expect(contextCommand?.description).toContain("context");
	});

	it("showContextPanel displays ContextPanelComponent in selector", async () => {
		harness = await createHarness();
		let selectorCreated: { component: unknown; focus: unknown } | undefined;
		const mockThis = {
			session: harness.session,
			ui: {
				terminal: { rows: 24 },
				requestRender: vi.fn(),
			},
			showSelector: (create: (done: () => void) => { component: unknown; focus: unknown }) => {
				selectorCreated = create(() => {});
			},
		};
		(
			InteractiveMode.prototype as unknown as {
				showContextPanel(this: typeof mockThis): void;
			}
		).showContextPanel.call(mockThis);

		expect(selectorCreated).toBeDefined();
		expect(selectorCreated?.component).toBeInstanceOf(ContextPanelComponent);
	});
});
