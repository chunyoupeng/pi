import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import {
	buildConversationContext,
	MAX_CONTEXT_CHARS,
	MAX_TOOL_RESULT_CHARS,
} from "../../src/extensions/btw/context.ts";

describe("buildConversationContext", () => {
	it("returns empty string for empty entries", () => {
		expect(buildConversationContext([])).toBe("");
	});

	it("extracts user and assistant messages", () => {
		const nowIso = new Date().toISOString();
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: nowIso,
				message: {
					role: "user",
					content: [{ type: "text", text: "Hello world" }],
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: nowIso,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hi there! How can I help?" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3-5-sonnet",
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
		];

		const context = buildConversationContext(entries);
		expect(context).toContain("User: Hello world");
		expect(context).toContain("Assistant: Hi there! How can I help?");
	});

	it("includes bashExecution output unless excludeFromContext is set", () => {
		const nowIso = new Date().toISOString();
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: nowIso,
				message: {
					role: "bashExecution",
					command: "git status",
					output: "On branch main\nnothing to commit",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: nowIso,
				message: {
					role: "bashExecution",
					command: "echo secret",
					output: "secret",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					excludeFromContext: true,
					timestamp: Date.now(),
				},
			},
		];

		const context = buildConversationContext(entries);
		expect(context).toContain("git status");
		expect(context).toContain("On branch main");
		expect(context).not.toContain("echo secret");
	});

	it("formats tool calls and tool results with length caps", () => {
		const nowIso = new Date().toISOString();
		const longResult = "x".repeat(MAX_TOOL_RESULT_CHARS + 200);
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: nowIso,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Let me check." },
						{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -la" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3-5-sonnet",
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: nowIso,
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: longResult }],
					isError: false,
					timestamp: Date.now(),
				},
			},
		];

		const context = buildConversationContext(entries);
		expect(context).toContain('[Tool call: bash({"command":"ls -la"})]');
		expect(context).toContain("[Tool result from bash:");
		expect(context).toContain("[truncated]");
		expect(context.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 500);
	});

	it("includes compaction and branch summaries", () => {
		const nowIso = new Date().toISOString();
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				summary: "Discussed repository structure and decided on architecture.",
				firstKeptEntryId: "entry_1",
				tokensBefore: 5000,
				timestamp: nowIso,
			},
			{
				type: "branch_summary",
				id: "b1",
				parentId: "c1",
				fromId: "c1",
				summary: "Abandoned branch trying alternative approach.",
				timestamp: nowIso,
			},
		];

		const context = buildConversationContext(entries);
		expect(context).toContain("[Compaction summary: Discussed repository structure and decided on architecture.]");
		expect(context).toContain("[Branch summary: Abandoned branch trying alternative approach.]");
	});

	it("truncates from the beginning if total characters exceed limit", () => {
		const nowIso = new Date().toISOString();
		const hugeText = "Large message block ".repeat(2500); // ~50,000 characters
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: nowIso,
				message: {
					role: "user",
					content: [{ type: "text", text: hugeText }],
					timestamp: Date.now(),
				},
			},
		];

		const context = buildConversationContext(entries);
		expect(context).toContain("[Earlier context omitted; showing recent conversation history.]");
		expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + 100);
	});
});
