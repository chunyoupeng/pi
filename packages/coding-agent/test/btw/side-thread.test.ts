import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildFirstQuestionPrompt,
	buildFollowUpPrompt,
	buildSideThreadMessages,
	createSideThread,
	extractAssistantText,
	runSideQuestionStream,
} from "../../src/extensions/btw/side-thread.ts";

const testModel: Model<Api> = {
	id: "mock-model",
	name: "Mock Model",
	provider: "mock-provider",
	baseUrl: "https://api.openai.com/v1",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function createMockMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock-provider",
		model: "mock-model",
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
	};
}

describe("side-thread", () => {
	it("builds first question prompt with conversation context", () => {
		const prompt = buildFirstQuestionPrompt("What is X?", "Prior context here");
		expect(prompt).toContain("<side_question>\nWhat is X?\n</side_question>");
		expect(prompt).toContain("<conversation_context>\nPrior context here\n</conversation_context>");
	});

	it("builds follow up prompt without repeating conversation context", () => {
		const prompt = buildFollowUpPrompt("And what about Y?");
		expect(prompt).toContain("<side_question>\nAnd what about Y?\n</side_question>");
		expect(prompt).not.toContain("<conversation_context>");
	});

	it("extracts text from assistant message", () => {
		const msg = createMockMessage("Hello world\nSecond line");
		expect(extractAssistantText(msg)).toBe("Hello world\nSecond line");
	});

	it("builds multi-turn side thread messages correctly", () => {
		const thread = createSideThread("Main session context");
		const msg1 = createMockMessage("Answer to first question");
		thread.turns.push({
			question: "First question",
			answer: "Answer to first question",
			response: msg1,
		});

		const messages = buildSideThreadMessages(thread, "Second question", testModel);
		expect(messages.length).toBe(3);
		expect(messages[0].role).toBe("user");
		expect((messages[0].content[0] as { text: string }).text).toContain("First question");
		expect((messages[0].content[0] as { text: string }).text).toContain("Main session context");

		expect(messages[1].role).toBe("assistant");
		expect(extractAssistantText(messages[1] as AssistantMessage)).toBe("Answer to first question");

		expect(messages[2].role).toBe("user");
		expect((messages[2].content[0] as { text: string }).text).toContain("Second question");
		expect((messages[2].content[0] as { text: string }).text).not.toContain("Main session context");
	});

	it("runs stream successfully and appends answered turn to side thread", async () => {
		const thread = createSideThread("Snapshot context");
		const controller = new AbortController();

		const stream = createAssistantMessageEventStream();
		const finalMsg = createMockMessage("Streamed final answer");

		const mockProvider: Provider = {
			id: "mock-provider",
			name: "Mock Provider",
			auth: {
				apiKey: {
					name: "Mock",
					async resolve() {
						return undefined;
					},
				},
			},
			getModels: () => [testModel],
			stream: () => stream,
			streamSimple: () => stream,
		};

		const updates: Array<{ status: string; text: string }> = [];

		const runPromise = runSideQuestionStream({
			model: testModel,
			provider: mockProvider,
			auth: { ok: true, apiKey: "test-key" },
			question: "How does this work?",
			thread,
			signal: controller.signal,
			onUpdate: (update) => updates.push({ status: update.status, text: update.text }),
		});

		// Emit streaming events
		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "thinking...",
			partial: createMockMessage(""),
		});
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Streamed ",
			partial: createMockMessage("Streamed "),
		});
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "final answer",
			partial: createMockMessage("Streamed final answer"),
		});
		stream.push({
			type: "done",
			reason: "stop",
			message: finalMsg,
		});

		const result = await runPromise;
		expect(result.kind).toBe("done");
		if (result.kind === "done") {
			expect(result.text).toBe("Streamed final answer");
		}

		expect(thread.turns.length).toBe(1);
		expect(thread.turns[0].question).toBe("How does this work?");
		expect(thread.turns[0].answer).toBe("Streamed final answer");

		expect(updates.some((u) => u.status === "thinking")).toBe(true);
		expect(updates.some((u) => u.status === "streaming" && u.text === "Streamed ")).toBe(true);
		expect(updates.some((u) => u.status === "done" && u.text === "Streamed final answer")).toBe(true);
	});

	it("propagates auth.baseUrl and env to provider streamSimple (regression for issue 1)", async () => {
		const thread = createSideThread("Context");
		const controller = new AbortController();
		const stream = createAssistantMessageEventStream();
		let calledModel: Model<Api> | undefined;
		let calledOptions: unknown;

		const mockProvider: Provider = {
			id: "mock-provider",
			name: "Mock Provider",
			auth: {
				apiKey: {
					name: "Mock",
					async resolve() {
						return undefined;
					},
				},
			},
			getModels: () => [testModel],
			stream: () => stream,
			streamSimple: (m, _ctx, opts) => {
				calledModel = m;
				calledOptions = opts;
				return stream;
			},
		};

		const customBaseUrl = "https://custom-proxy.internal/v1";
		const customEnv = { HTTP_PROXY: "http://proxy:8080" };

		const runPromise = runSideQuestionStream({
			model: testModel,
			provider: mockProvider,
			auth: { ok: true, apiKey: "test-key", baseUrl: customBaseUrl, env: customEnv },
			question: "Testing custom baseUrl",
			thread,
			signal: controller.signal,
		});

		stream.push({
			type: "done",
			reason: "stop",
			message: createMockMessage("OK"),
		});

		await runPromise;

		expect(calledModel?.baseUrl).toBe(customBaseUrl);
		expect((calledOptions as { env?: Record<string, string> })?.env).toEqual(customEnv);
	});

	it("handles abort signal cancellation during streaming", async () => {
		const thread = createSideThread("Snapshot context");
		const controller = new AbortController();

		const stream = createAssistantMessageEventStream();
		const mockProvider: Provider = {
			id: "mock-provider",
			name: "Mock Provider",
			auth: {
				apiKey: {
					name: "Mock",
					async resolve() {
						return undefined;
					},
				},
			},
			getModels: () => [testModel],
			stream: () => stream,
			streamSimple: () => stream,
		};

		const updates: Array<{ status: string; text: string }> = [];

		const runPromise = runSideQuestionStream({
			model: testModel,
			provider: mockProvider,
			auth: { ok: true, apiKey: "test-key" },
			question: "Will this be cancelled?",
			thread,
			signal: controller.signal,
			onUpdate: (update) => updates.push({ status: update.status, text: update.text }),
		});

		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Partial start...",
			partial: createMockMessage("Partial start..."),
		});

		// Abort
		controller.abort();
		stream.push({
			type: "error",
			reason: "aborted",
			error: createMockMessage("Aborted"),
		});

		const result = await runPromise;
		expect(result.kind).toBe("cancelled");
		// Aborted turn must not be added to thread turns
		expect(thread.turns.length).toBe(0);
		expect(updates.at(-1)?.status).toBe("cancelled");
	});

	it("handles error during streaming gracefully", async () => {
		const thread = createSideThread("Snapshot context");
		const controller = new AbortController();

		const stream = createAssistantMessageEventStream();
		const mockProvider: Provider = {
			id: "mock-provider",
			name: "Mock Provider",
			auth: {
				apiKey: {
					name: "Mock",
					async resolve() {
						return undefined;
					},
				},
			},
			getModels: () => [testModel],
			stream: () => stream,
			streamSimple: () => stream,
		};

		const errorMsg: AssistantMessage = {
			...createMockMessage(""),
			stopReason: "error",
			errorMessage: "Rate limit exceeded",
		};

		const runPromise = runSideQuestionStream({
			model: testModel,
			provider: mockProvider,
			auth: { ok: true, apiKey: "test-key" },
			question: "Trigger error",
			thread,
			signal: controller.signal,
		});

		stream.push({
			type: "error",
			reason: "error",
			error: errorMsg,
		});

		const result = await runPromise;
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.error).toContain("Rate limit exceeded");
		}
		expect(thread.turns.length).toBe(0);
	});
});
