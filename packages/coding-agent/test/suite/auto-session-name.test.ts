import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import autoSessionNameExtension from "../../src/extensions/auto-session-name/index.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

describe("automatic session names", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({ ...options, extensionFactories: [autoSessionNameExtension] });
		harnesses.push(harness);
		return harness;
	}

	async function runThreeRounds(harness: Harness): Promise<void> {
		for (let i = 1; i <= 3; i++) {
			harness.setResponses([fauxAssistantMessage(`Reply ${i}`)]);
			await harness.session.prompt(`Question ${i}`);
		}
	}

	it("is registered as a built-in extension", () => {
		expect(builtInExtensions).toContainEqual({
			name: "auto-session-name",
			factory: autoSessionNameExtension,
			builtin: true,
		});
	});

	it("names only after the fourth completed round, without adding the request to chat history", async () => {
		const harness = await setup();
		await runThreeRounds(harness);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(3);

		harness.setResponses([
			fauxAssistantMessage("Reply 4"),
			(context, options, _state, model) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("Question 1");
				expect(text).toContain("Reply 4");
				expect(options?.reasoning).toBeUndefined();
				expect(options?.maxTokens).toBe(128);
				expect(model.id).toBe(harness.getModel().id);
				return fauxAssistantMessage("“修复 session 自动命名”\nextra line");
			},
		]);
		await harness.session.prompt("Question 4");

		expect(harness.sessionManager.getSessionName()).toBe("修复 session 自动命名");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual([
			"修复 session 自动命名",
		]);
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(4);
		expect(harness.session.messages.map(getMessageText).join("\n")).not.toContain("修复 session 自动命名");

		harness.setResponses([fauxAssistantMessage("Reply 5")]);
		await harness.session.prompt("Question 5");
		expect(harness.faux.state.callCount).toBe(6);

		harness.session.setSessionName("");
		harness.setResponses([fauxAssistantMessage("Reply 6")]);
		await harness.session.prompt("Question 6");
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(7);
	});

	it("does not overwrite an existing name or make a title request", async () => {
		const harness = await setup();
		harness.session.setSessionName("Manual title");
		await runThreeRounds(harness);
		harness.setResponses([fauxAssistantMessage("Reply 4")]);
		await harness.session.prompt("Question 4");
		expect(harness.sessionManager.getSessionName()).toBe("Manual title");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("preserves a name set while title generation is in progress", async () => {
		const harness = await setup();
		await runThreeRounds(harness);
		harness.setResponses([
			fauxAssistantMessage("Reply 4"),
			() => {
				harness.session.setSessionName("Manual title");
				return fauxAssistantMessage("Generated title");
			},
		]);
		await harness.session.prompt("Question 4");
		expect(harness.sessionManager.getSessionName()).toBe("Manual title");
	});

	it("does not count tool calls as user/reply rounds or send tool data to the title model", async () => {
		const harness = await setup({
			tools: [
				{
					name: "noop",
					label: "noop",
					description: "No operation",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "private tool result" }], details: {} }),
				},
			],
		});
		harness.setResponses([
			...Array.from({ length: 4 }, () => fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })),
			fauxAssistantMessage("Reply 1"),
		]);
		await harness.session.prompt("Question 1");
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		for (let i = 2; i <= 3; i++) {
			harness.setResponses([fauxAssistantMessage(`Reply ${i}`)]);
			await harness.session.prompt(`Question ${i}`);
		}
		harness.setResponses([
			fauxAssistantMessage("Reply 4"),
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).not.toContain("private tool result");
				return fauxAssistantMessage("Tool workflow");
			},
		]);
		await harness.session.prompt("Question 4");
		expect(harness.sessionManager.getSessionName()).toBe("Tool workflow");
	});

	it.each(["aborted", "error", "length"] as const)("does not name after a %s reply", async (stopReason) => {
		const harness = await setup({ settings: { retry: { enabled: false } } });
		await runThreeRounds(harness);
		harness.setResponses([fauxAssistantMessage("Incomplete", { stopReason })]);
		await harness.session.prompt("Question 4");
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(4);
		harness.setResponses([fauxAssistantMessage("Reply 5"), fauxAssistantMessage("Recovered session")]);
		await harness.session.prompt("Question 5");
		expect(harness.sessionManager.getSessionName()).toBe("Recovered session");
	});

	it.each(["", "   ", "\n\n"])("ignores an empty generated title %j and retries on a later reply", async (title) => {
		const harness = await setup();
		await runThreeRounds(harness);
		harness.setResponses([fauxAssistantMessage("Reply 4"), fauxAssistantMessage(title)]);
		await harness.session.prompt("Question 4");
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		harness.setResponses([fauxAssistantMessage("Reply 5"), fauxAssistantMessage("Useful title")]);
		await harness.session.prompt("Question 5");
		expect(harness.sessionManager.getSessionName()).toBe("Useful title");
	});

	it("ignores a failed title request without failing the user run", async () => {
		const harness = await setup();
		await runThreeRounds(harness);
		harness.setResponses([
			fauxAssistantMessage("Reply 4"),
			fauxAssistantMessage("Partial title", { stopReason: "error", errorMessage: "Unavailable" }),
		]);
		await harness.session.prompt("Question 4");
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(harness.eventsOfType("agent_settled")).toHaveLength(4);
	});

	it("cancels the title request with the user run", async () => {
		const harness = await setup();
		await runThreeRounds(harness);
		harness.setResponses([
			fauxAssistantMessage("Reply 4"),
			async (_context, options) => {
				void harness.session.abort();
				expect(options?.signal?.aborted).toBe(true);
				return fauxAssistantMessage("Cancelled title");
			},
		]);
		await harness.session.prompt("Question 4");
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("bounds conversation input and title length", async () => {
		const harness = await setup();
		for (let i = 0; i < 3; i++) {
			harness.setResponses([fauxAssistantMessage("a".repeat(10_000))]);
			await harness.session.prompt("u".repeat(10_000));
		}
		harness.setResponses([
			fauxAssistantMessage("a".repeat(10_000)),
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expect(getMessageText(user).length).toBeLessThan(8200);
				return fauxAssistantMessage("𠮷".repeat(80));
			},
		]);
		await harness.session.prompt("u".repeat(10_000));
		expect(harness.sessionManager.getSessionName()).toBe("𠮷".repeat(64));
	});

	it("counts persisted history on resume, using only the active branch", async () => {
		const manager = SessionManager.inMemory();
		for (let i = 1; i <= 3; i++) {
			manager.appendMessage({ role: "user", content: `Question ${i}`, timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage(`Reply ${i}`));
		}
		const branchPoint = manager.getLeafId();
		manager.appendMessage({ role: "user", content: "Abandoned question", timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage("Abandoned reply"));
		manager.branch(branchPoint!);
		const harness = await setup({ sessionManager: manager });
		harness.setResponses([
			fauxAssistantMessage("Reply 4"),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("Question 1");
				expect(text).not.toContain("Abandoned");
				return fauxAssistantMessage("Resumed session");
			},
		]);
		await harness.session.prompt("Question 4");
		expect(manager.getSessionName()).toBe("Resumed session");
	});
});
