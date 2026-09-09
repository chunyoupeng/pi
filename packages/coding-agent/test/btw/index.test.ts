import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import btwExtension from "../../src/extensions/btw/index.ts";
import { initTheme, type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";

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

function createMockTui(overrides?: Partial<TUI>): TUI {
	return {
		terminal: { rows: 24, columns: 80 },
		requestRender: vi.fn(),
		onTerminalFocusChange: vi.fn((_listener: (focused: boolean) => void) => () => {}),
		getTerminalFocused: vi.fn(() => true),
		getShowHardwareCursor: vi.fn(() => false),
		...overrides,
	} as unknown as TUI;
}

type CustomComponentFactory<T = void> = (
	tui: TUI,
	themeInstance: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => { render(width: number): string[]; handleInput(data: string): void; dispose?(): void } | Promise<unknown>;

function createMockAssistantMessage(text: string): AssistantMessage {
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

describe("btw extension index", () => {
	initTheme("dark");

	function createHarness() {
		const commands = new Map<
			string,
			{ description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
		>();
		const eventHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();

		const mockPi = {
			registerCommand: (
				name: string,
				opts: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => {
				commands.set(name, opts);
			},
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
			},
		} as unknown as ExtensionAPI;

		btwExtension(mockPi);
		return { commands, eventHandlers };
	}

	function createMockContext(overrides?: Partial<Record<string, unknown>>) {
		const notifications: Array<{ message: string; level: string }> = [];
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

		const ctx = {
			mode: "tui",
			hasUI: true,
			model: testModel,
			thinkingLevel: "off",
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key" }),
				getProvider: vi.fn().mockReturnValue(mockProvider),
			},
			sessionManager: {
				buildContextEntries: vi.fn().mockReturnValue([]),
			},
			ui: {
				theme,
				notify: vi.fn((msg: string, level: string) => {
					notifications.push({ message: msg, level });
				}),
				custom: vi.fn(),
			},
			...overrides,
		} as unknown as ExtensionCommandContext;

		return { ctx, notifications, stream, mockProvider };
	}

	it("registers the /btw command and session lifecycle events", () => {
		const { commands, eventHandlers } = createHarness();
		expect(commands.has("btw")).toBe(true);
		expect(eventHandlers.has("session_shutdown")).toBe(true);
		expect(eventHandlers.has("session_tree")).toBe(true);
		expect(eventHandlers.has("session_start")).toBe(true);
	});

	it("guards command for non-TUI mode to avoid background calls", async () => {
		const { commands } = createHarness();
		const { ctx, notifications } = createMockContext({ mode: "print", hasUI: false });

		const handler = commands.get("btw")!.handler;
		await handler("What is this?", ctx);

		expect(notifications.some((n) => n.message.includes("requires interactive TUI mode"))).toBe(true);
		expect(ctx.ui.custom).not.toHaveBeenCalled();
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("opens fullscreen overlay UI when /btw is called without args", async () => {
		const { commands } = createHarness();
		const { ctx } = createMockContext();

		const handler = commands.get("btw")!.handler;
		await handler("", ctx);

		expect(ctx.ui.custom).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				overlay: true,
				overlayOptions: {
					maxHeight: "100%",
					width: "100%",
					anchor: "top-left",
				},
			}),
		);
	});

	it("opens fullscreen overlay UI and passes initialQuestion when /btw <question> is called", async () => {
		const { commands } = createHarness();
		const { ctx } = createMockContext();

		const handler = commands.get("btw")!.handler;
		await handler("What is the architecture?", ctx);

		expect(ctx.ui.custom).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				overlay: true,
				overlayOptions: {
					maxHeight: "100%",
					width: "100%",
					anchor: "top-left",
				},
			}),
		);

		// Verify that the view created by factory has the initialQuestion
		const customMock = ctx.ui.custom as unknown as ReturnType<typeof vi.fn>;
		const factory = customMock.mock.calls[0][0] as CustomComponentFactory;
		const mockTui = createMockTui();
		const kb = new KeybindingsManager();
		const component = factory(mockTui, theme, kb, vi.fn());

		expect(component).toBeDefined();
		expect(typeof (component as { render: unknown }).render).toBe("function");
		expect(typeof (component as { handleInput: unknown }).handleInput).toBe("function");
		(component as { dispose?: () => void }).dispose?.();
	});

	it("opens fullscreen viewer on /btw show without initial question", async () => {
		const { commands } = createHarness();
		const { ctx } = createMockContext();

		const handler = commands.get("btw")!.handler;
		await handler("show", ctx);

		expect(ctx.ui.custom).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				overlay: true,
			}),
		);
	});

	it("clears conversation state via /btw clear", async () => {
		const { commands } = createHarness();
		const { ctx, notifications } = createMockContext();

		const handler = commands.get("btw")!.handler;
		await handler("First question", ctx);

		await handler("clear", ctx);
		expect(notifications.some((n) => n.message.includes("Cleared"))).toBe(true);
	});

	it("handles /btw cancel when active or idle", async () => {
		const { commands } = createHarness();
		const { ctx, notifications } = createMockContext();

		const handler = commands.get("btw")!.handler;
		await handler("cancel", ctx);
		expect(notifications.some((n) => n.message.includes("No active /btw question to cancel"))).toBe(true);
	});

	it("cleans up state on session_shutdown and session_tree", async () => {
		const { commands, eventHandlers } = createHarness();
		const { ctx } = createMockContext();

		const handler = commands.get("btw")!.handler;
		await handler("Query before switch", ctx);

		const treeHandlers = eventHandlers.get("session_tree")!;
		expect(() => treeHandlers[0]({}, ctx)).not.toThrow();

		const shutdownHandlers = eventHandlers.get("session_shutdown")!;
		expect(() => shutdownHandlers[0]({}, ctx)).not.toThrow();
	});

	it("retains side thread across multiple invocations in the same session", async () => {
		const { commands } = createHarness();
		const { ctx, stream, mockProvider } = createMockContext();

		const handler = commands.get("btw")!.handler;

		// 1. Invoke /btw First question
		const customMock = ctx.ui.custom as unknown as ReturnType<typeof vi.fn>;
		customMock.mockImplementationOnce(async (factory: CustomComponentFactory) => {
			const mockTui = createMockTui();
			const kb = new KeybindingsManager();
			const component = factory(mockTui, theme, kb, () => {});
			// Stream response
			stream.push({
				type: "done",
				reason: "stop",
				message: createMockAssistantMessage("Answer 1"),
			});
			await new Promise((r) => setTimeout(r, 10));
			return component;
		});

		await handler("First question", ctx);

		// 2. Invoke /btw Second question - should reuse the existing thread
		const stream2 = createAssistantMessageEventStream();
		mockProvider.streamSimple = () => stream2;

		customMock.mockImplementationOnce(async (factory: CustomComponentFactory) => {
			const mockTui = createMockTui();
			const kb = new KeybindingsManager();
			const component = factory(mockTui, theme, kb, () => {});
			return component;
		});

		await handler("", ctx);
		expect(customMock).toHaveBeenCalledTimes(2);
	});
});
