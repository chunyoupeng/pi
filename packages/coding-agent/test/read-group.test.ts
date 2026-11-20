import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { type ToolRenderers, withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ReadGroupComponent } from "../src/modes/interactive/components/read-group.ts";
import { type ToolCallHandle, ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function renderComponent(component: { render(width: number): string[] }, width = 120): string {
	return stripAnsi(component.render(width).join("\n"));
}

function createFakeTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI;
}

type FakeInteractiveContext = {
	pendingTools: Map<string, ToolCallHandle>;
	turnTools: Set<ToolCallHandle>;
	chatContainer: Container;
	loadedResourcesContainer: Container;
	footer: { invalidate(): void; setLiveOutputTokens(tokens: number): void };
	programStatus: { handleEvent(): void };
	ui: TUI;
	settingsManager: SettingsManager;
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: { retryAttempt: number; modelRuntime: { getAvailableSnapshot(): unknown[] } };
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	isInitialized: boolean;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	agentStartedAt: number | undefined;
	completedAgentOutputTokens: number;
	defaultWorkingMessage: string;
	addToolOutputDividerBeforeNextAssistant: boolean;
	retryEscapeHandler: undefined;
	customHeader: undefined;
	builtInHeader: undefined;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): ToolRenderers | undefined;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getMarkdownTransformers(): readonly [];
	addMessageToChat(message: AgentMessage): void;
	renderSessionItems: (items: AgentMessage[]) => void;
	hasVisibleAssistantText: (message: AssistantMessage) => boolean;
	addToolOutputDivider: () => void;
	addToolOutputDividerBefore: (component: unknown) => void;
	clearStatusIndicator(kind?: string): void;
	clearLiveOutputTokens(): void;
	updateLiveOutputTokens(message: AssistantMessage): void;
	updateWorkingOutputTokenLabel(tokens: number): void;
	maybeShowThinkingDropNotice(message: AssistantMessage): void;
	maybeShowCacheMissNotice(message: AssistantMessage): void;
	showStatus(message: string): void;
	showLoadedResources(options?: { force?: boolean; showDiagnosticsWhenQuiet?: boolean }): void;
	setToolsExpanded: (expanded: boolean) => void;
	maybeShowInstallChangeWarning(): void;
	updatePendingMessagesDisplay(): void;
};

function createFakeInteractiveContext(options?: {
	customReadRenderer?: ToolRenderers;
	collapseToolOutput?: boolean;
}): FakeInteractiveContext {
	const chatContainer = new Container();
	const settingsManager = SettingsManager.inMemory({ collapseToolOutput: options?.collapseToolOutput });
	const proto = InteractiveMode.prototype as unknown as {
		renderSessionItems: (items: AgentMessage[]) => void;
		setToolsExpanded: (expanded: boolean) => void;
		hasVisibleAssistantText: (message: AssistantMessage) => boolean;
		addToolOutputDivider: () => void;
		addToolOutputDividerBefore: (component: unknown) => void;
		getMarkdownThemeWithSettings: () => MarkdownTheme;
	};
	return {
		pendingTools: new Map<string, ToolCallHandle>(),
		turnTools: new Set<ToolCallHandle>(),
		chatContainer,
		loadedResourcesContainer: new Container(),
		footer: { invalidate: vi.fn(), setLiveOutputTokens: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: createFakeTui(),
		settingsManager,
		sessionManager: { getCwd: () => "/repo", getEntries: () => [] },
		session: { retryAttempt: 0, modelRuntime: { getAvailableSnapshot: () => [] } },
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		isInitialized: true,
		streamingComponent: undefined,
		streamingMessage: undefined,
		agentStartedAt: undefined,
		completedAgentOutputTokens: 0,
		defaultWorkingMessage: "Working",
		addToolOutputDividerBeforeNextAssistant: false,
		retryEscapeHandler: undefined,
		customHeader: undefined,
		builtInHeader: undefined,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: (toolName: string) =>
			toolName === "read" && options?.customReadRenderer
				? options.customReadRenderer
				: withBuiltInRenderers(toolName, undefined),
		getMarkdownThemeWithSettings: proto.getMarkdownThemeWithSettings,
		getMarkdownTransformers: () => [],
		addMessageToChat(message: AgentMessage) {
			if (message.role === "assistant") {
				const component = new AssistantMessageComponent(message, this.hideThinkingBlock);
				component.setExpanded(this.toolOutputExpanded);
				chatContainer.addChild(component);
			} else if (message.role === "user") {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("");
				chatContainer.addChild(new UserMessageComponent(text));
			}
		},
		renderSessionItems: proto.renderSessionItems,
		hasVisibleAssistantText: proto.hasVisibleAssistantText,
		addToolOutputDivider: proto.addToolOutputDivider,
		addToolOutputDividerBefore: proto.addToolOutputDividerBefore,
		clearStatusIndicator: vi.fn(),
		clearLiveOutputTokens: vi.fn(),
		updateLiveOutputTokens: vi.fn(),
		updateWorkingOutputTokenLabel: vi.fn(),
		maybeShowThinkingDropNotice: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		showStatus: vi.fn(),
		showLoadedResources: vi.fn(),
		setToolsExpanded: proto.setToolsExpanded,
		maybeShowInstallChangeWarning: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
	};
}

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResult(id: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

function createEntries(messages: AgentMessage[]): SessionEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

describe("ReadGroupComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders Reading N files... while in progress and Read N files on completion without body preview", () => {
		const ui = createFakeTui();
		const group = new ReadGroupComponent({ showImages: false }, ui, "/repo");

		const first = group.addCall("r1", { path: "src/a.ts", offset: 1, limit: 20 });
		first.markExecutionStarted();
		expect(renderComponent(group)).toContain("Reading 1 file...");
		expect(renderComponent(group)).toContain("└─ src/a.ts:1-20");

		const second = group.addCall("r2", { path: "src/b.ts" });
		second.markExecutionStarted();
		expect(renderComponent(group)).toContain("Reading 2 files...");
		expect(renderComponent(group)).toContain("└─ src/a.ts:1-20");
		expect(renderComponent(group)).toContain("└─ src/b.ts");

		first.updateResult({ content: [{ type: "text", text: "FIRST_FILE_BODY" }], isError: false });
		// Still in progress until second finishes
		expect(renderComponent(group)).toContain("Reading 2 files...");
		expect(renderComponent(group)).not.toContain("FIRST_FILE_BODY");

		second.updateResult({ content: [{ type: "text", text: "SECOND_FILE_BODY" }], isError: false });
		const doneOutput = renderComponent(group);
		expect(doneOutput).toContain("Read 2 files");
		expect(doneOutput).not.toContain("Reading 2 files...");
		expect(doneOutput).toContain("└─ src/a.ts:1-20");
		expect(doneOutput).toContain("└─ src/b.ts");
		expect(doneOutput).not.toContain("FIRST_FILE_BODY");
		expect(doneOutput).not.toContain("SECOND_FILE_BODY");
		expect(group.render(120).find((line) => stripAnsi(line).includes("⏺"))).toContain(theme.fg("success", "⏺"));

		group.dispose();
	});

	it("updates streamed arguments and expands/collapses full file output via setExpanded and click", () => {
		const ui = createFakeTui();
		const group = new ReadGroupComponent({ showImages: false }, ui, "/repo");

		const handle = group.addCall("r1", {});
		expect(renderComponent(group)).toContain("└─ ...");

		handle.updateArgs({ path: "src/streamed.ts" });
		expect(renderComponent(group)).toContain("└─ src/streamed.ts");

		handle.updateResult({ content: [{ type: "text", text: "export const SECRET_BODY = 42;" }], isError: false });
		expect(renderComponent(group)).not.toContain("SECRET_BODY");

		// Expand via Ctrl+O (setExpanded)
		group.setExpanded(true);
		expect(renderComponent(group)).toContain("SECRET_BODY");

		// Collapse via setExpanded
		group.setExpanded(false);
		expect(renderComponent(group)).not.toContain("SECRET_BODY");

		// Left-click toggles expanded -> reveals body; second click collapses again
		const width = 120;
		const lines = group.render(width);
		const headerRow = lines.findIndex((line) => stripAnsi(line).includes("Read 1 file"));
		expect(headerRow).toBeGreaterThanOrEqual(0);
		const clickEvent: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 4,
			y: headerRow,
			screenX: 4,
			screenY: headerRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(group.handleMouse(clickEvent)?.handled).toBe(true);
		expect(renderComponent(group)).toContain("SECRET_BODY");

		expect(group.handleMouse(clickEvent)?.handled).toBe(true);
		expect(renderComponent(group)).not.toContain("SECRET_BODY");
		group.dispose();
	});

	it("shows red status bullet and concise error summary when a read fails", () => {
		const ui = createFakeTui();
		const group = new ReadGroupComponent({ showImages: false }, ui, "/repo");

		const ok = group.addCall("r1", { path: "src/ok.ts" });
		const bad = group.addCall("r2", { path: "src/missing.ts" });
		ok.updateResult({ content: [{ type: "text", text: "ok content" }], isError: false });
		bad.updateResult({ content: [{ type: "text", text: "ENOENT: no such file\nstack line" }], isError: true });

		const rendered = group.render(120);
		expect(rendered.find((line) => stripAnsi(line).includes("⏺"))).toContain(theme.fg("error", "⏺"));
		const plain = stripAnsi(rendered.join("\n"));
		expect(plain).toContain("Read 2 files");
		expect(plain).toContain("└─ src/missing.ts ENOENT: no such file");
		expect(plain).not.toContain("stack line");

		group.setExpanded(true);
		expect(renderComponent(group)).toContain("stack line");
		group.dispose();
	});
});

describe("InteractiveMode consecutive read grouping", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	const handleEvent = (
		InteractiveMode.prototype as unknown as {
			handleEvent: (this: FakeInteractiveContext, event: AgentSessionEvent) => Promise<void>;
		}
	).handleEvent;

	const renderSessionEntries = (
		InteractiveMode.prototype as unknown as {
			renderSessionEntries: (this: FakeInteractiveContext, entries: SessionEntry[]) => void;
		}
	).renderSessionEntries;

	it("groups consecutive reads across turns (N+1) and resets to 1 when broken by another tool, text, or agent_end", async () => {
		const ctx = createFakeInteractiveContext();

		await handleEvent.call(ctx, { type: "agent_start" });

		// Turn 1: thinking (hidden) + read a.ts
		const msg1 = createAssistantMessage([
			{ type: "thinking", thinking: "Let me inspect a.ts" },
			{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } },
		]);
		await handleEvent.call(ctx, { type: "message_start", message: msg1 });
		await handleEvent.call(ctx, { type: "message_update", message: msg1 } as unknown as AgentSessionEvent);
		await handleEvent.call(ctx, { type: "message_end", message: msg1 });
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "r1",
			toolName: "read",
			args: { path: "src/a.ts" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "r1",
			toolName: "read",
			result: { content: [{ type: "text", text: "A_BODY" }], details: undefined },
			isError: false,
		});

		// Turn 2: thinking (hidden) + parallel read b.ts & c.ts -> joins group -> N = 3
		const msg2 = createAssistantMessage([
			{ type: "thinking", thinking: "Now check b.ts and c.ts" },
			{ type: "toolCall", id: "r2", name: "read", arguments: { path: "src/b.ts" } },
			{ type: "toolCall", id: "r3", name: "read", arguments: { path: "src/c.ts" } },
		]);
		await handleEvent.call(ctx, { type: "message_start", message: msg2 });
		await handleEvent.call(ctx, { type: "message_update", message: msg2 } as unknown as AgentSessionEvent);
		await handleEvent.call(ctx, { type: "message_end", message: msg2 });
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "r2",
			toolName: "read",
			args: { path: "src/b.ts" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "r3",
			toolName: "read",
			args: { path: "src/c.ts" },
		});

		expect(renderComponent(ctx.chatContainer)).toContain("Reading 3 files...");

		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "r2",
			toolName: "read",
			result: { content: [{ type: "text", text: "B_BODY" }], details: undefined },
			isError: false,
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "r3",
			toolName: "read",
			result: { content: [{ type: "text", text: "C_BODY" }], details: undefined },
			isError: false,
		});

		// Turn 3: bash breaks continuity, then read d.ts restarts from 1
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "echo hi" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "b1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "hi" }], details: undefined },
			isError: false,
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "r4",
			toolName: "read",
			args: { path: "src/d.ts" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "r4",
			toolName: "read",
			result: { content: [{ type: "text", text: "D_BODY" }], details: undefined },
			isError: false,
		});

		// Turn 4: visible assistant text breaks continuity, then read e.ts restarts from 1
		const msg4 = createAssistantMessage([
			{ type: "text", text: "Checking one more file." },
			{ type: "toolCall", id: "r5", name: "read", arguments: { path: "src/e.ts" } },
		]);
		await handleEvent.call(ctx, { type: "message_start", message: msg4 });
		await handleEvent.call(ctx, { type: "message_update", message: msg4 } as unknown as AgentSessionEvent);
		await handleEvent.call(ctx, { type: "message_end", message: msg4 });
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "r5",
			toolName: "read",
			args: { path: "src/e.ts" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "r5",
			toolName: "read",
			result: { content: [{ type: "text", text: "E_BODY" }], details: undefined },
			isError: false,
		});

		await handleEvent.call(ctx, { type: "agent_end", messages: [], willRetry: false });

		// New agent turn after agent_end also restarts from 1 even without an intervening user message
		await handleEvent.call(ctx, { type: "agent_start" });
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "r6",
			toolName: "read",
			args: { path: "src/f.ts" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "r6",
			toolName: "read",
			result: { content: [{ type: "text", text: "F_BODY" }], details: undefined },
			isError: false,
		});

		const readGroups = ctx.chatContainer.children.filter((c) => c instanceof ReadGroupComponent);
		expect(readGroups).toHaveLength(4);
		expect(renderComponent(readGroups[0]!)).toContain("Read 3 files");
		expect(renderComponent(readGroups[0]!)).toContain("└─ src/a.ts");
		expect(renderComponent(readGroups[0]!)).toContain("└─ src/b.ts");
		expect(renderComponent(readGroups[0]!)).toContain("└─ src/c.ts");
		expect(renderComponent(readGroups[1]!)).toContain("Read 1 file");
		expect(renderComponent(readGroups[1]!)).toContain("└─ src/d.ts");
		expect(renderComponent(readGroups[2]!)).toContain("Read 1 file");
		expect(renderComponent(readGroups[2]!)).toContain("└─ src/e.ts");
		expect(renderComponent(readGroups[3]!)).toContain("Read 1 file");
		expect(renderComponent(readGroups[3]!)).toContain("└─ src/f.ts");

		// None of the file bodies are shown while collapsed
		const fullChat = renderComponent(ctx.chatContainer);
		expect(fullChat).not.toContain("A_BODY");
		expect(fullChat).not.toContain("D_BODY");

		// Global expand (Ctrl+O) reveals file bodies
		ctx.setToolsExpanded(true);
		const expandedChat = renderComponent(ctx.chatContainer);
		expect(expandedChat).toContain("A_BODY");
		expect(expandedChat).toContain("D_BODY");
	});

	it("groups consecutive reads identically when replaying session entries", () => {
		const ctx = createFakeInteractiveContext();
		const entries = createEntries([
			createAssistantMessage([
				{ type: "thinking", thinking: "Step 1" },
				{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
			]),
			createToolResult("r1", "read", "A_TEXT"),
			createAssistantMessage([
				{ type: "thinking", thinking: "Step 2" },
				{ type: "toolCall", id: "r2", name: "read", arguments: { path: "b.ts" } },
			]),
			createToolResult("r2", "read", "B_TEXT"),
			createAssistantMessage([{ type: "text", text: "Found it" }]),
			{ role: "user", content: "Check c.ts too", timestamp: Date.now() },
			createAssistantMessage([{ type: "toolCall", id: "r3", name: "read", arguments: { path: "c.ts" } }]),
			createToolResult("r3", "read", "C_TEXT"),
		]);

		renderSessionEntries.call(ctx, entries);

		const readGroups = ctx.chatContainer.children.filter((c) => c instanceof ReadGroupComponent);
		expect(readGroups).toHaveLength(2);
		expect(renderComponent(readGroups[0]!)).toContain("Read 2 files");
		expect(renderComponent(readGroups[0]!)).toContain("└─ a.ts");
		expect(renderComponent(readGroups[0]!)).toContain("└─ b.ts");
		expect(renderComponent(readGroups[1]!)).toContain("Read 1 file");
		expect(renderComponent(readGroups[1]!)).toContain("└─ c.ts");
		expect(renderComponent(ctx.chatContainer)).not.toContain("A_TEXT");
	});

	it("preserves custom extension read renderers via ToolExecutionComponent", async () => {
		const ctx = createFakeInteractiveContext({
			customReadRenderer: {
				renderCall: () => new Text("CUSTOM_READ_CALL", 0, 0),
				renderResult: () => new Text("CUSTOM_READ_RESULT", 0, 0),
			},
		});

		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "r1",
			toolName: "read",
			args: { path: "src/a.ts" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "r1",
			toolName: "read",
			result: { content: [{ type: "text", text: "body" }], details: undefined },
			isError: false,
		});

		expect(ctx.chatContainer.children.some((c) => c instanceof ReadGroupComponent)).toBe(false);
		expect(ctx.chatContainer.children.some((c) => c instanceof ToolExecutionComponent)).toBe(true);
		expect(renderComponent(ctx.chatContainer)).toContain("CUSTOM_READ_CALL");
	});
});
