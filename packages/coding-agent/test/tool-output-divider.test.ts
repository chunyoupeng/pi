import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { DynamicBorder } from "../src/modes/interactive/components/dynamic-border.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "antigravity-acp",
		provider: "antigravity-acp",
		model: "gemini-4-neon",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createHarness(renderers: Record<string, (entry: unknown) => Text | undefined>) {
	const proto = InteractiveMode.prototype as unknown as Record<string, unknown>;
	const chatContainer = new Container();
	const settingsManager = SettingsManager.inMemory();
	const fakeThis: Record<string, unknown> = {
		isInitialized: true,
		chatContainer,
		loadedResourcesContainer: new Container(),
		pendingMessagesContainer: new Container(),
		footer: { invalidate: vi.fn(), setLiveOutputTokens: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } } as unknown as TUI,
		settingsManager,
		sessionManager: { getCwd: () => "/repo", getEntries: () => [] },
		session: {
			retryAttempt: 0,
			modelRuntime: { getAvailableSnapshot: () => [] },
			extensionRunner: {
				getEntryRenderer: (type: string) => renderers[type],
			},
		},
		pendingTools: new Map(),
		turnTools: new Set(),
		entriesRenderedByBoundaryCompaction: new Set(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		streamingComponent: undefined,
		streamingMessage: undefined,
		streamingContentStart: 0,
		agentStartedAt: undefined,
		assistantFirstTokenAt: undefined,
		completedAgentGenerationMs: 0,
		completedAgentOutputTokens: 0,
		requestInputTokens: undefined,
		defaultWorkingMessage: "Working",
		isAssistantThinking: false,
		addToolOutputDividerBeforeNextAssistant: false,
		defaultEditor: { onEscape: undefined },
		retryEscapeHandler: undefined,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: () => undefined,
		getMarkdownThemeWithSettings: proto.getMarkdownThemeWithSettings,
		getMarkdownTransformers: () => [],
		addCustomEntryToChat: proto.addCustomEntryToChat,
		addMessageToChat: proto.addMessageToChat,
		getUserMessageText: proto.getUserMessageText,
		renderSessionItems: proto.renderSessionItems,
		hasVisibleAssistantText: proto.hasVisibleAssistantText,
		addToolOutputDivider: proto.addToolOutputDivider,
		addToolOutputDividerBefore: proto.addToolOutputDividerBefore,
		clearStatusIndicator: vi.fn(),
		clearLiveOutputTokens: vi.fn(),
		startRequestInputPhase: vi.fn(),
		isFirstOutputTokenEvent: proto.isFirstOutputTokenEvent,
		updateLiveOutputTokens: vi.fn(),
		updateWorkingOutputTokenLabel: vi.fn(),
		maybeShowThinkingDropNotice: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		showStatus: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
	};

	const handleEvent = (event: AgentSessionEvent) =>
		(proto.handleEvent as (event: AgentSessionEvent) => Promise<void>).call(fakeThis, event);
	const renderSessionEntries = (entries: SessionEntry[]) =>
		(proto.renderSessionEntries as (entries: SessionEntry[]) => void).call(fakeThis, entries);

	return { fakeThis, chatContainer, handleEvent, renderSessionEntries };
}

describe("tool output divider", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a divider before assistant text when a visible custom entry arrives before any streamed content", async () => {
		const { chatContainer, handleEvent } = createHarness({
			"antigravity-acp-tool-activity": () => new Text("Read 2 files", 0, 0),
		});

		const emptyAssistant = makeAssistantMessage("");
		const finalAssistant = makeAssistantMessage("Done reading.");

		await handleEvent({ type: "agent_start" });
		await handleEvent({ type: "message_start", message: emptyAssistant });
		await handleEvent({
			type: "entry_appended",
			entry: {
				type: "custom",
				id: "e1",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "antigravity-acp-tool-activity",
				data: {},
			},
		} as unknown as AgentSessionEvent);
		await handleEvent({
			type: "entry_appended",
			entry: {
				type: "custom",
				id: "e2",
				parentId: "e1",
				timestamp: new Date().toISOString(),
				customType: "antigravity-acp-tool-activity",
				data: {},
			},
		} as unknown as AgentSessionEvent);
		await handleEvent({ type: "message_end", message: finalAssistant });

		const dividers = chatContainer.children.filter((c) => c instanceof DynamicBorder);
		expect(dividers).toHaveLength(1);
	});

	it("does not render a divider for invisible custom entries", async () => {
		const { chatContainer, handleEvent } = createHarness({
			"hidden-entry": () => undefined,
		});

		await handleEvent({ type: "agent_start" });
		await handleEvent({ type: "message_start", message: makeAssistantMessage("") });
		await handleEvent({
			type: "entry_appended",
			entry: {
				type: "custom",
				id: "e1",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "hidden-entry",
				data: {},
			},
		} as unknown as AgentSessionEvent);
		await handleEvent({ type: "message_end", message: makeAssistantMessage("Plain answer.") });

		expect(chatContainer.children.filter((c) => c instanceof DynamicBorder)).toHaveLength(0);
	});

	it("renders a divider after visible custom entries during session replay, but resets on user messages", () => {
		const { chatContainer, renderSessionEntries } = createHarness({
			"antigravity-acp-tool-activity": () => new Text("Read 2 files", 0, 0),
		});

		const entries: SessionEntry[] = [
			{
				type: "custom",
				id: "c1",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "antigravity-acp-tool-activity",
				data: {},
			},
			{
				type: "message",
				id: "m1",
				parentId: "c1",
				timestamp: new Date().toISOString(),
				message: makeAssistantMessage("Answer after tool"),
			},
			{
				type: "custom",
				id: "c2",
				parentId: "m1",
				timestamp: new Date().toISOString(),
				customType: "antigravity-acp-tool-activity",
				data: {},
			},
			{
				type: "message",
				id: "m2",
				parentId: "c2",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Next turn", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: new Date().toISOString(),
				message: makeAssistantMessage("Answer without tool"),
			},
		];

		renderSessionEntries(entries);

		expect(chatContainer.children.filter((c) => c instanceof DynamicBorder)).toHaveLength(1);
	});

	it("adapts divider width dynamically to narrow split screens and wide full screens", () => {
		let pad = 1;
		const divider = new DynamicBorder(undefined, () => pad);

		const narrow = stripAnsi(divider.render(70)[0]!);
		expect(narrow).toBe(` ${"─".repeat(68)}`);

		const wide = stripAnsi(divider.render(160)[0]!);
		expect(wide).toBe(` ${"─".repeat(158)}`);

		pad = 2;
		const widerPad = stripAnsi(divider.render(120)[0]!);
		expect(widerPad).toBe(`  ${"─".repeat(116)}`);
	});
});
