import type { Model } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createCodingToolDefinitions,
	createCodingTools,
	createSubagentTool,
	formatSubagentToolCall,
	formatSubagentUsage,
	formatTokens,
	loadCustomProfilesFromDir,
	renderSubagentCall,
	renderSubagentResult,
	resolveSubagentProfiles,
} from "../src/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const mockModel: Model<"anthropic-messages"> = {
	id: "mock-model",
	name: "Mock Model",
	api: "anthropic-messages",
	provider: "mock-provider",
	baseUrl: "https://api.example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
	contextWindow: 128000,
	maxTokens: 4096,
};

describe("Subagent Core & Tool", () => {
	let testDir: string;

	beforeEach(() => {
		initTheme("dark");
		testDir = join(tmpdir(), `subagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("Subagent Profiles", () => {
		it("should expose built-in profiles", () => {
			// Pass testDir as agentDir so user-level ~/.pi/agent/agents cannot leak into the test.
			const profiles = resolveSubagentProfiles(testDir, testDir);
			expect(profiles.scout).toBeDefined();
			expect(profiles.scout.tools).toEqual(["read", "grep", "find", "ls"]);
			expect(profiles.planner).toBeDefined();
			expect(profiles.reviewer).toBeDefined();
			expect(profiles.worker).toBeDefined();
			expect(profiles.worker.tools).toContain("write");
			expect(profiles.worker.tools).toContain("edit");
			expect(profiles.worker.tools).toContain("bash");
		});

		it("should load custom profiles from markdown files", () => {
			const agentsDir = join(testDir, "agents");
			mkdirSync(agentsDir, { recursive: true });

			const customAgentContent = `---
name: custom-scout
description: Custom exploration agent
tools: read, grep
model: mock-provider/mock-model
thinkingLevel: high
---
You are a custom scout agent.`;

			writeFileSync(join(agentsDir, "custom-scout.md"), customAgentContent);

			const loaded = loadCustomProfilesFromDir(agentsDir, "user");
			expect(loaded.length).toBe(1);
			expect(loaded[0].name).toBe("custom-scout");
			expect(loaded[0].description).toBe("Custom exploration agent");
			expect(loaded[0].tools).toEqual(["read", "grep"]);
			expect(loaded[0].modelId).toBe("mock-provider/mock-model");
			expect(loaded[0].thinkingLevel).toBe("high");
			expect(loaded[0].systemPrompt).toContain("You are a custom scout agent.");
		});

		it("should merge custom project agents with built-in profiles", () => {
			const projectPiAgentsDir = join(testDir, ".pi", "agents");
			mkdirSync(projectPiAgentsDir, { recursive: true });

			const projectAgent = `---
name: tester
description: Unit test generator
tools:
  - read
  - write
---
Write unit tests.`;

			writeFileSync(join(projectPiAgentsDir, "tester.md"), projectAgent);

			const resolved = resolveSubagentProfiles(testDir, testDir);
			expect(resolved.scout).toBeDefined();
			expect(resolved.tester).toBeDefined();
			expect(resolved.tester.tools).toEqual(["read", "write"]);
			expect(resolved.tester.source).toBe("project");
		});
	});

	describe("UI Formatting & Rendering", () => {
		it("should format tokens and usage stats correctly", () => {
			expect(formatTokens(500)).toBe("500");
			expect(formatTokens(2500)).toBe("2.5k");
			expect(formatTokens(15000)).toBe("15k");
			expect(formatTokens(2500000)).toBe("2.5M");

			const usage = {
				turns: 2,
				input: 2400,
				output: 600,
				cacheRead: 1000,
				cacheWrite: 200,
				cost: 0.0025,
			};
			const formatted = formatSubagentUsage(usage, "mock-model");
			expect(formatted).toContain("2 turns");
			expect(formatted).toContain("↑2.4k");
			expect(formatted).toContain("↓600");
			expect(formatted).toContain("R1.0k");
			expect(formatted).toContain("W200");
			expect(formatted).toContain("$0.0025");
			expect(formatted).toContain("mock-model");
		});

		it("should format subagent tool calls", () => {
			const bashCall = formatSubagentToolCall("bash", { command: "git status" }, theme);
			expect(bashCall).toContain("git status");

			const readCall = formatSubagentToolCall("read", { path: "src/index.ts", offset: 10, limit: 20 }, theme);
			expect(readCall).toContain("read");
			expect(readCall).toContain("src/index.ts");
			expect(readCall).toContain(":10-29");

			const grepCall = formatSubagentToolCall("grep", { query: "export const" }, theme);
			expect(grepCall).toContain("grep");
			expect(grepCall).toContain("export const");
		});

		it("should render call preview", () => {
			const comp = renderSubagentCall({ agent: "scout", task: "Analyze auth logic" }, theme, {} as any);
			expect(comp).toBeInstanceOf(Text);
			const rendered = (comp as Text).render(80).join("\n");
			expect(rendered).toContain("Subagent");
			expect(rendered).toContain("Scout");
			expect(rendered).toContain("Analyze auth logic");
		});

		it("should render collapsed and expanded result views", () => {
			const result = {
				content: [{ type: "text" as const, text: "Summary text" }],
				details: {
					agent: "scout",
					task: "Explore code",
					status: "completed" as const,
					source: "built-in",
					model: "mock-model",
					steps: [
						{ type: "toolCall" as const, name: "read", args: { path: "file1.ts" } },
						{ type: "toolCall" as const, name: "grep", args: { query: "foo" } },
					],
					finalText: "Summary text",
					usage: {
						turns: 1,
						input: 1000,
						output: 200,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0.001,
					},
				},
			};

			// Collapsed view
			const collapsed = renderSubagentResult(result, { expanded: false, isPartial: false }, theme, {
				isError: false,
			} as any);
			expect(collapsed).toBeInstanceOf(Text);
			const collapsedText = (collapsed as Text).render(80).join("\n");
			expect(collapsedText).toContain("Scout");
			expect(collapsedText).toContain("read");
			expect(collapsedText).toContain("grep");

			// Expanded view
			const expanded = renderSubagentResult(result, { expanded: true, isPartial: false }, theme, {
				isError: false,
			} as any);
			expect(expanded).toBeInstanceOf(Container);
		});
	});

	describe("Tool Execution & Validation", () => {
		it("should throw a descriptive error when requesting an unknown subagent", async () => {
			const tool = createSubagentTool(testDir, { defaultModel: mockModel });

			await expect(tool.execute("call-1", { agent: "non-existent-agent", task: "do something" })).rejects.toThrow(
				/Unknown subagent 'non-existent-agent'/,
			);
		});

		it("should reject execution if abort signal is already aborted", async () => {
			const tool = createSubagentTool(testDir, { defaultModel: mockModel });
			const controller = new AbortController();
			controller.abort();

			await expect(
				tool.execute("call-2", { agent: "scout", task: "do something" }, controller.signal),
			).rejects.toThrow(/aborted/i);
		});

		it("should include subagent in default coding tools", () => {
			const tools = createCodingTools(testDir);
			expect(tools.map((t) => t.name)).toContain("subagent");

			const definitions = createCodingToolDefinitions(testDir);
			expect(definitions.map((d) => d.name)).toContain("subagent");
		});
	});
});
