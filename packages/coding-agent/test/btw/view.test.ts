import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import { type KeybindingsConfig, KeybindingsManager } from "../../src/core/keybindings.ts";
import { createSideThread } from "../../src/extensions/btw/side-thread.ts";
import { BtwView } from "../../src/extensions/btw/view.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const testModel: Model<Api> = {
	id: "test-llm",
	name: "Test LLM",
	provider: "mock-provider",
	baseUrl: "https://api.openai.com/v1",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function createMockAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock-provider",
		model: "test-llm",
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

describe("BtwView fullscreen component", () => {
	initTheme("dark");

	function createViewHarness(options?: {
		initialQuestion?: string;
		threadHistory?: Array<{ question: string; answer: string }>;
		userKeybindings?: KeybindingsConfig;
	}) {
		const stream = createAssistantMessageEventStream();
		let streamFactory = () => stream;

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
			stream: () => streamFactory(),
			streamSimple: () => streamFactory(),
		};

		const modelRegistry = {
			getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key" }),
			getProvider: vi.fn().mockReturnValue(mockProvider),
		} as unknown as ExtensionCommandContext["modelRegistry"];

		const thread = createSideThread("Main conversation summary context.");
		if (options?.threadHistory) {
			for (const turn of options.threadHistory) {
				thread.turns.push({
					question: turn.question,
					answer: turn.answer,
					response: createMockAssistantMessage(turn.answer),
				});
			}
		}

		const mockTui = {
			terminal: { rows: 24, columns: 80 },
			requestRender: vi.fn(),
			onTerminalFocusChange: () => () => {},
			getTerminalFocused: () => true,
			getShowHardwareCursor: () => false,
		};

		const kb = new KeybindingsManager(options?.userKeybindings ?? {});
		const onDone = vi.fn();

		const view = new BtwView({
			tui: mockTui as unknown as TUI,
			theme,
			keybindings: kb,
			thread,
			model: testModel,
			modelRegistry,
			thinkingLevel: "off",
			initialQuestion: options?.initialQuestion,
			onDone,
		});

		return {
			view,
			stream,
			setStreamFactory: (fn: () => ReturnType<typeof createAssistantMessageEventStream>) => {
				streamFactory = fn;
			},
			mockTui,
			thread,
			modelRegistry,
			kb,
			onDone,
		};
	}

	it("renders onboarding welcome card when opened with empty thread and no question", () => {
		const { view } = createViewHarness();
		const lines = view.render(80);
		const output = lines.join("\n");
		expect(output).toContain("btw");
		expect(output).toContain("Side Conversation");
		expect(output).toContain("cancel");
		expect(output).toContain("return to main");
	});

	it("streams response for initialQuestion including thinking and text deltas", async () => {
		const { view, stream } = createViewHarness({ initialQuestion: "What is this?" });

		// Wait for microtask to submit initial question
		await new Promise((r) => setTimeout(r, 10));

		let output = view.render(80).join("\n");
		expect(output).toContain("What is this?");
		expect(output).toContain("[thinking...]");

		// Emit text delta
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Streaming answer piece...",
			partial: createMockAssistantMessage("Streaming answer piece..."),
		});
		await new Promise((r) => setTimeout(r, 100));

		output = view.render(80).join("\n");
		expect(output).toContain("[streaming...]");
		expect(output).toContain("Streaming answer piece...");

		// Complete stream
		stream.push({
			type: "done",
			reason: "stop",
			message: createMockAssistantMessage("Streaming answer piece... Final answer."),
		});
		await new Promise((r) => setTimeout(r, 10));

		output = view.render(80).join("\n");
		expect(output).toContain("Final answer.");
		expect(view.focused).toBe(true);
	});

	it("supports repeated asks inside the same view with multi-turn context", async () => {
		const { view, stream, thread, setStreamFactory } = createViewHarness({ initialQuestion: "Q1" });

		await new Promise((r) => setTimeout(r, 10));

		// Complete turn 1
		stream.push({
			type: "done",
			reason: "stop",
			message: createMockAssistantMessage("Answer 1"),
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(thread.turns.length).toBe(1);
		expect(thread.turns[0].question).toBe("Q1");
		expect(thread.turns[0].answer).toBe("Answer 1");

		// Prepare stream for turn 2
		const stream2 = createAssistantMessageEventStream();
		setStreamFactory(() => stream2);

		// Submit second question inside the editor
		view.handleInput("Q");
		view.handleInput("2");
		view.handleInput("\r"); // Enter to submit
		await new Promise((r) => setTimeout(r, 10));

		const output = view.render(80).join("\n");
		expect(output).toContain("Q1");
		expect(output).toContain("Answer 1");
		expect(output).toContain("Q2");

		// Complete turn 2
		stream2.push({
			type: "done",
			reason: "stop",
			message: createMockAssistantMessage("Answer 2"),
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(thread.turns.length).toBe(2);
		expect(thread.turns[1].question).toBe("Q2");
		expect(thread.turns[1].answer).toBe("Answer 2");
	});

	it("queues questions submitted while busy and runs them in order after stream completes", async () => {
		const { view, stream, thread, setStreamFactory } = createViewHarness({ initialQuestion: "Slow question 1" });

		await new Promise((r) => setTimeout(r, 10));

		// Prepare stream for queued question
		const stream2 = createAssistantMessageEventStream();
		setStreamFactory(() => stream2);

		// While stream 1 is busy, submit question 2
		view.handleInput("Queued question 2");
		view.handleInput("\r");

		// View should display queued indicator
		let output = view.render(80).join("\n");
		expect(output).toContain("[queued: 1]");

		// Now complete stream 1
		stream.push({
			type: "done",
			reason: "stop",
			message: createMockAssistantMessage("Answer to slow question 1"),
		});
		await new Promise((r) => setTimeout(r, 20));

		// Question 2 should now be actively running
		output = view.render(80).join("\n");
		expect(output).toContain("Queued question 2");

		// Complete question 2
		stream2.push({
			type: "done",
			reason: "stop",
			message: createMockAssistantMessage("Answer to queued question 2"),
		});
		await new Promise((r) => setTimeout(r, 20));

		expect(thread.turns.length).toBe(2);
		expect(thread.turns[0].question).toBe("Slow question 1");
		expect(thread.turns[1].question).toBe("Queued question 2");
	});

	it("cancels only side request via Ctrl+C without affecting main task", async () => {
		const { view, stream, thread } = createViewHarness({ initialQuestion: "Long streaming query" });

		await new Promise((r) => setTimeout(r, 10));

		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Partial data received",
			partial: createMockAssistantMessage("Partial data received"),
		});
		await new Promise((r) => setTimeout(r, 10));

		// Press Ctrl+C (key code \x03)
		view.handleInput("\x03");

		const output = view.render(80).join("\n");
		expect(output).toContain("(Cancelled)");
		expect(output).toContain("[cancelled]");

		// Thread history records the cancelled state
		expect(thread.turns.length).toBe(1);
		expect(thread.turns[0].answer).toContain("(Cancelled)");
	});

	it("clears editor text when Ctrl+C is pressed while idle", () => {
		const { view } = createViewHarness();
		view.handleInput("Some draft text");
		view.handleInput("\x03");
		// After Ctrl+C, editor is cleared
		view.handleInput("\r"); // Enter on empty editor should not submit
		expect(view.render(80).join("\n")).not.toContain("Some draft text");
	});

	it("returns to main and cancels ongoing side request on Esc to avoid hidden costs", async () => {
		const { view, stream, thread, onDone } = createViewHarness({ initialQuestion: "Query to cancel on escape" });

		await new Promise((r) => setTimeout(r, 10));

		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Early tokens before user presses Esc",
			partial: createMockAssistantMessage("Early tokens before user presses Esc"),
		});
		await new Promise((r) => setTimeout(r, 10));

		// Press Escape (\x1b)
		view.handleInput("\x1b");

		expect(onDone).toHaveBeenCalledTimes(1);

		// Verified: turn is preserved in thread history with cancellation notice
		expect(thread.turns.length).toBe(1);
		expect(thread.turns[0].answer).toContain("(Cancelled)");
	});

	it("retains all prior turns when reopening in a new view", () => {
		const history = [
			{ question: "Earlier turn 1", answer: "Prior answer 1" },
			{ question: "Earlier turn 2", answer: "Prior answer 2" },
		];

		const { view } = createViewHarness({ threadHistory: history });
		const output = view.render(80).join("\n");

		expect(output).toContain("Earlier turn 1");
		expect(output).toContain("Prior answer 1");
		expect(output).toContain("Earlier turn 2");
		expect(output).toContain("Prior answer 2");
	});

	it("supports scrolling with pageUp and pageDown", () => {
		const history = Array.from({ length: 15 }, (_, i) => ({
			question: `Question ${i + 1}`,
			answer: `Answer line 1 for question ${i + 1}\nAnswer line 2\nAnswer line 3`,
		}));

		const { view } = createViewHarness({ threadHistory: history });

		// Default render at 24 rows
		const initialLines = view.render(80);
		expect(initialLines.length).toBe(24);

		// Scroll up with PageUp (\x1b[5~)
		view.handleInput("\x1b[5~");
		const scrolledUpLines = view.render(80);
		expect(scrolledUpLines).toBeDefined();

		// Scroll down with PageDown (\x1b[6~)
		view.handleInput("\x1b[6~");
		const scrolledDownLines = view.render(80);
		expect(scrolledDownLines).toBeDefined();
	});

	it("renders cleanly on narrow terminals and short terminal heights without throwing", () => {
		const { view } = createViewHarness({ initialQuestion: "Short screen test" });

		// Narrow width (30 cols)
		const narrowLines = view.render(30);
		expect(narrowLines.length).toBeLessThanOrEqual(24);
		for (const line of narrowLines) {
			// Lines must not overflow visual width
			expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		}

		// Very short height (5 rows)
		const mockShortTui = {
			terminal: { rows: 5, columns: 40 },
			requestRender: vi.fn(),
			onTerminalFocusChange: () => () => {},
			getTerminalFocused: () => true,
			getShowHardwareCursor: () => false,
		};
		const shortView = new BtwView({
			tui: mockShortTui as unknown as TUI,
			theme,
			keybindings: new KeybindingsManager({}),
			thread: createSideThread("context"),
			model: testModel,
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(),
				getProvider: vi.fn(),
			} as unknown as ExtensionCommandContext["modelRegistry"],
			onDone: vi.fn(),
		});

		const shortLines = shortView.render(40);
		expect(shortLines.length).toBeLessThanOrEqual(5);

		// Invalidate clears cache
		expect(() => shortView.invalidate()).not.toThrow();
	});

	it("handles model credentials failure cleanly with error indicator in transcript", async () => {
		const { view, modelRegistry } = createViewHarness({ initialQuestion: "Auth fail query" });

		vi.mocked(modelRegistry.getApiKeyAndHeaders).mockRejectedValueOnce(new Error("Missing API Key"));

		await new Promise((r) => setTimeout(r, 10));

		const output = view.render(80).join("\n");
		expect(output).toContain("Model credentials failed");
		expect(output).toContain("[error]");
	});

	it("handles missing provider cleanly", async () => {
		const { view, modelRegistry } = createViewHarness({ initialQuestion: "Missing provider query" });

		vi.mocked(modelRegistry.getProvider).mockReturnValueOnce(undefined);

		await new Promise((r) => setTimeout(r, 10));

		const output = view.render(80).join("\n");
		expect(output).toContain("No provider registered");
	});

	it("handles stream error event gracefully", async () => {
		const { view, stream } = createViewHarness({ initialQuestion: "Failing query" });

		await new Promise((r) => setTimeout(r, 10));

		stream.push({
			type: "error",
			reason: "error",
			error: {
				...createMockAssistantMessage(""),
				stopReason: "error",
				errorMessage: "Rate limit exceeded",
			},
		});
		await new Promise((r) => setTimeout(r, 10));

		const output = view.render(80).join("\n");
		expect(output).toContain("Rate limit exceeded");
	});

	it("aborts active stream on dispose without throwing", async () => {
		const { view } = createViewHarness({ initialQuestion: "To dispose" });

		await new Promise((r) => setTimeout(r, 10));

		expect(() => view.dispose()).not.toThrow();
		// Calling dispose again is safe
		expect(() => view.dispose()).not.toThrow();
	});

	it("supports keybinding remapping for cancel and close", async () => {
		// Remap cancel to ctrl+k (\x0b) and close to ctrl+q (\x11)
		const { view, onDone } = createViewHarness({
			initialQuestion: "Remap test query",
			userKeybindings: {
				"app.btw.cancel": "ctrl+k",
				"app.btw.close": "ctrl+q",
			},
		});

		await new Promise((r) => setTimeout(r, 10));

		// Check footer hints reflect remapped keys
		const output = stripAnsi(view.render(80).join("\n"));
		expect(output).toContain("ctrl+k cancel");
		expect(output).toContain("ctrl+q return to main");

		// Press default Ctrl+C (\x03) - should NOT cancel because remapped
		view.handleInput("\x03");
		expect(view.render(80).join("\n")).not.toContain("(Cancelled)");

		// Press remapped Ctrl+K (\x0b) - should cancel
		view.handleInput("\x0b");
		expect(view.render(80).join("\n").toLowerCase()).toContain("cancelled");

		// Press default Esc (\x1b) - should NOT close because remapped
		view.handleInput("\x1b");
		expect(onDone).not.toHaveBeenCalled();

		// Press remapped Ctrl+Q (\x11) - should close
		view.handleInput("\x11");
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("preserves cursor marker and editable lines when multiline text is typed on 24 rows", () => {
		const { view } = createViewHarness();

		// Type multiple lines into the editor (using Shift+Enter / \n)
		view.handleInput("First line of query\n");
		view.handleInput("Second line of query\n");
		view.handleInput("Third line with cursor here");

		const lines = view.render(80);
		expect(lines.length).toBe(24);

		const rendered = lines.join("\n");
		// Verify CURSOR_MARKER is present and not cropped away
		expect(rendered).toContain("\x1b_pi:c\x07");
		// Verify editable lines are present
		expect(rendered).toContain("First line of query");
		expect(rendered).toContain("Second line of query");
		expect(rendered).toContain("Third line with cursor here");
	});

	it("preserves cursor marker and content when cursor is on first line of multiline query", () => {
		const { view } = createViewHarness();

		view.handleInput("First line of query\n");
		view.handleInput("Second line of query\n");
		view.handleInput("Third line of query");

		// Navigate cursor back to the first line
		view.handleInput("\x1b[A"); // Up arrow
		view.handleInput("\x1b[A"); // Up arrow

		const lines = view.render(80);
		expect(lines.length).toBe(24);

		const rendered = lines.join("\n");
		expect(rendered).toContain("\x1b_pi:c\x07");
		expect(stripAnsi(rendered)).toContain("First line of query");
	});

	it("renders cleanly across tiny terminal heights (3-7 rows) preserving cursor marker", () => {
		for (let rows = 3; rows <= 7; rows++) {
			const mockTinyTui = {
				terminal: { rows, columns: 60 },
				requestRender: vi.fn(),
				onTerminalFocusChange: () => () => {},
				getTerminalFocused: () => true,
				getShowHardwareCursor: () => false,
			};

			const tinyView = new BtwView({
				tui: mockTinyTui as unknown as TUI,
				theme,
				keybindings: new KeybindingsManager({}),
				thread: createSideThread("context"),
				model: testModel,
				modelRegistry: {
					getApiKeyAndHeaders: vi.fn(),
					getProvider: vi.fn(),
				} as unknown as ExtensionCommandContext["modelRegistry"],
				onDone: vi.fn(),
			});

			tinyView.handleInput("Line 1 in tiny\n");
			tinyView.handleInput("Line 2 in tiny");
			// Navigate cursor to first line
			tinyView.handleInput("\x1b[A");

			const lines = tinyView.render(60);
			expect(lines.length).toBe(rows);

			const rendered = lines.join("\n");
			expect(rendered).toContain("\x1b_pi:c\x07");
			expect(stripAnsi(rendered)).toContain("Line 1 in tiny");
			tinyView.dispose();
		}
	});

	it("cleans up editor terminal focus listener on dispose across repeated reopens", () => {
		let activeListeners = 0;
		const mockTui = {
			terminal: { rows: 24, columns: 80 },
			requestRender: vi.fn(),
			onTerminalFocusChange: () => {
				activeListeners++;
				return () => {
					activeListeners--;
				};
			},
			getTerminalFocused: () => true,
			getShowHardwareCursor: () => false,
		};

		// Open and dispose repeatedly
		for (let i = 0; i < 5; i++) {
			const view = new BtwView({
				tui: mockTui as unknown as TUI,
				theme,
				keybindings: new KeybindingsManager({}),
				thread: createSideThread("context"),
				model: testModel,
				modelRegistry: {
					getApiKeyAndHeaders: vi.fn(),
					getProvider: vi.fn(),
				} as unknown as ExtensionCommandContext["modelRegistry"],
				onDone: vi.fn(),
			});

			expect(activeListeners).toBe(1);
			view.dispose();
			expect(activeListeners).toBe(0);
		}
	});

	it("toggles thinking block expansion via app.tools.expand shortcut and applies to newly streamed components", async () => {
		const { view, stream, setStreamFactory } = createViewHarness({
			initialQuestion: "Thinking test question",
			userKeybindings: {
				"app.tools.expand": "ctrl+e",
			},
		});

		await new Promise((r) => setTimeout(r, 10));

		// Push thinking and done on turn 1
		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "Internal reasoning details line 1",
			partial: createMockAssistantMessage(""),
		});
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Answer to question",
			partial: {
				...createMockAssistantMessage("Answer to question"),
				content: [
					{ type: "thinking", thinking: "Internal reasoning details line 1" },
					{ type: "text", text: "Answer to question" },
				],
			},
		});
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				...createMockAssistantMessage("Answer to question"),
				content: [
					{ type: "thinking", thinking: "Internal reasoning details line 1" },
					{ type: "text", text: "Answer to question" },
				],
			},
		});
		await new Promise((r) => setTimeout(r, 10));

		// By default thinking is collapsed (not expanded)
		let output = view.render(80).join("\n");
		expect(output).not.toContain("Internal reasoning details");

		// Default Ctrl+O (\x0f) should NOT toggle because remapped to ctrl+e
		view.handleInput("\x0f");
		output = view.render(80).join("\n");
		expect(output).not.toContain("Internal reasoning details");

		// Remapped Ctrl+E (\x05) should toggle thinking expansion
		view.handleInput("\x05");
		output = view.render(80).join("\n");
		expect(output).toContain("Internal reasoning details");

		// Now submit turn 2 while thinking is expanded
		const stream2 = createAssistantMessageEventStream();
		setStreamFactory(() => stream2);

		view.handleInput("Turn 2 query");
		view.handleInput("\r");
		await new Promise((r) => setTimeout(r, 10));

		// Turn 2 stream emits thinking
		stream2.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "Turn 2 internal reasoning",
			partial: createMockAssistantMessage(""),
		});
		stream2.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Turn 2 answer",
			partial: {
				...createMockAssistantMessage("Turn 2 answer"),
				content: [
					{ type: "thinking", thinking: "Turn 2 internal reasoning" },
					{ type: "text", text: "Turn 2 answer" },
				],
			},
		});
		await new Promise((r) => setTimeout(r, 10));

		// Newly streamed component must also be expanded
		output = view.render(80).join("\n");
		expect(output).toContain("Turn 2 internal reasoning");

		// Toggle back with Ctrl+E (\x05)
		view.handleInput("\x05");
		output = view.render(80).join("\n");
		expect(output).not.toContain("Turn 2 internal reasoning");
	});

	it("supports default Ctrl+O thinking expansion and legacy expandTools keybinding migration", async () => {
		const { view, stream } = createViewHarness({
			initialQuestion: "Thinking default key test",
			userKeybindings: {
				"app.expandTools": "ctrl+y",
			},
		});

		await new Promise((r) => setTimeout(r, 10));

		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "Reasoning hidden by default",
			partial: createMockAssistantMessage(""),
		});
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				...createMockAssistantMessage("Answer text"),
				content: [
					{ type: "thinking", thinking: "Reasoning hidden by default" },
					{ type: "text", text: "Answer text" },
				],
			},
		});
		await new Promise((r) => setTimeout(r, 10));

		let output = view.render(80).join("\n");
		expect(output).not.toContain("Reasoning hidden by default");

		// Remapped to ctrl+y (\x19) via legacy name migration
		view.handleInput("\x19");
		output = view.render(80).join("\n");
		expect(output).toContain("Reasoning hidden by default");
	});
});
