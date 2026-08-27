import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
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
	generateRandomName,
	generateSubagentSessionId,
	loadCustomProfilesFromDir,
	renderSubagentCall,
	renderSubagentResult,
	resolveSubagentProfiles,
	SUBAGENT_NAMES,
	SubagentSessionPool,
} from "../src/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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

			const shortReadCall = formatSubagentToolCall("read", { path: "src/components/index.ts" }, theme);
			expect(stripAnsi(shortReadCall)).toContain("read src/components/index.ts");

			const longReadCall = formatSubagentToolCall(
				"read",
				{
					path: "./air-unified-payment-core/src/main/java/com/umetrip/g3/core/air_unified_payment/test.js",
					offset: 1,
					limit: 200,
				},
				theme,
			);
			expect(stripAnsi(longReadCall)).toContain("read ./air-unified-payment-core/s/m/j/c/u/g/c/a/test.js:1-200");
			expect(stripAnsi(longReadCall)).not.toContain(
				"./air-unified-payment-core/src/main/java/com/umetrip/g3/core/air_unified_payment/test.js",
			);

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

		it("should render call preview with sessionId and resetSession", () => {
			const comp = renderSubagentCall(
				{ agent: "worker", task: "Continue refactoring", sessionId: "worker-jack-1234", resetSession: true },
				theme,
				{} as any,
			);
			expect(comp).toBeInstanceOf(Text);
			const rendered = (comp as Text).render(80).join("\n");
			expect(rendered).toContain("Subagent");
			expect(rendered).toContain("Worker");
			expect(rendered).toContain("worker-jack-1234");
			expect(rendered).toContain("[reset]");
			expect(rendered).toContain("Continue refactoring");
		});

		it("should render results with name, sessionId, and resumed tag", () => {
			const result = {
				content: [{ type: "text" as const, text: "Refactored module" }],
				details: {
					agent: "worker",
					name: "Jack",
					sessionId: "worker-jack-1234",
					isResumed: true,
					task: "Fix auth bug",
					status: "completed" as const,
					steps: [{ type: "toolCall" as const, name: "read", args: { path: "auth.ts" } }],
					finalText: "Fixed bug",
				},
			};

			const collapsed = renderSubagentResult(result, { expanded: false, isPartial: false }, theme, {
				isError: false,
			} as any);
			const collapsedText = (collapsed as Text).render(80).join("\n");
			expect(collapsedText).toContain("Worker");
			expect(collapsedText).toContain("Jack");
			expect(collapsedText).toContain("resumed");

			const expanded = renderSubagentResult(result, { expanded: true, isPartial: false }, theme, {
				isError: false,
			} as any);
			expect(expanded).toBeInstanceOf(Container);
		});
	});

	describe("Subagent Naming & Session ID Generation", () => {
		it("should generate a random name from SUBAGENT_NAMES list", () => {
			const name = generateRandomName();
			expect(SUBAGENT_NAMES).toContain(name as any);
		});

		it("should generate a formatted sessionId with role and suffix", () => {
			const sessionId = generateSubagentSessionId("worker", "Jack");
			expect(sessionId).toMatch(/^worker-jack-[a-z0-9]{4}$/);
		});
	});

	describe("SubagentSessionPool", () => {
		it("should store, retrieve, delete, and clear sessions", () => {
			const pool = new SubagentSessionPool();
			expect(pool.list().length).toBe(0);

			const fakeSession: any = {
				sessionId: "worker-alice-1234",
				name: "Alice",
				agent: "worker",
				subAgent: {} as any,
				createdAt: Date.now(),
				lastUsedAt: Date.now(),
				totalTurns: 1,
				totalUsage: { turns: 1, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
				historySteps: [],
			};

			pool.set(fakeSession.sessionId, fakeSession);
			expect(pool.has("worker-alice-1234")).toBe(true);
			expect(pool.get("worker-alice-1234")?.name).toBe("Alice");
			expect(pool.list().length).toBe(1);

			pool.delete("worker-alice-1234");
			expect(pool.has("worker-alice-1234")).toBe(false);

			pool.set(fakeSession.sessionId, fakeSession);
			pool.clear();
			expect(pool.list().length).toBe(0);
		});
	});

	describe("Multi-turn Session Persistence & Execution", () => {
		it("persists conversation across multiple turns with same sessionId and resets on request", async () => {
			const faux = registerFauxProvider({
				models: [{ id: "faux-1", reasoning: false }],
			});
			faux.setResponses([
				fauxAssistantMessage("Turn 1 output"),
				fauxAssistantMessage("Turn 2 output"),
				fauxAssistantMessage("Turn 3 output"),
			]);

			const fauxModel = faux.getModel();
			const pool = new SubagentSessionPool();
			const tool = createSubagentTool(testDir, { defaultModel: fauxModel, sessionPool: pool });

			// Turn 1: first invocation without explicit sessionId
			const result1 = await tool.execute("call-1", { agent: "worker", task: "First task" });
			expect(result1.details?.status).toBe("completed");
			expect(result1.details?.isResumed).toBe(false);
			expect(result1.details?.name).toBeDefined();
			expect(result1.details?.sessionId).toBeDefined();
			const sessionId = result1.details!.sessionId!;
			const name = result1.details!.name!;
			const firstContent = result1.content[0];
			const firstText = firstContent?.type === "text" ? firstContent.text : "";
			expect(firstText).toContain(`[Subagent: worker | Name: ${name} | Session: ${sessionId}]`);
			expect(firstText).toContain("Turn 1 output");
			expect(pool.has(sessionId)).toBe(true);

			// Turn 2: second invocation reusing the same sessionId
			const result2 = await tool.execute("call-2", { agent: "worker", task: "Follow-up task", sessionId });
			expect(result2.details?.status).toBe("completed");
			expect(result2.details?.isResumed).toBe(true);
			expect(result2.details?.name).toBe(name);
			expect(result2.details?.sessionId).toBe(sessionId);
			const secondContent = result2.content[0];
			const secondText = secondContent?.type === "text" ? secondContent.text : "";
			expect(secondText).toContain(`[Subagent: worker | Name: ${name} | Session: ${sessionId} (Resumed)]`);
			expect(secondText).toContain("Turn 2 output");

			// Turn 3: resetSession = true
			const result3 = await tool.execute("call-3", {
				agent: "worker",
				task: "Fresh task",
				sessionId,
				resetSession: true,
			});
			expect(result3.details?.status).toBe("completed");
			expect(result3.details?.isResumed).toBe(false);
			const thirdContent = result3.content[0];
			const thirdText = thirdContent?.type === "text" ? thirdContent.text : "";
			expect(thirdText).not.toContain("(Resumed)");
			expect(thirdText).toContain("Turn 3 output");

			faux.unregister();
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
