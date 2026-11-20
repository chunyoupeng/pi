import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { type ToolRenderers, withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import type { CodemodeNestedCall, CodemodeToolDetails } from "../src/extensions/codemode/tool.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CodemodeGroupComponent } from "../src/modes/interactive/components/codemode-group.ts";
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

function makeNestedCalls(names: readonly string[]): CodemodeNestedCall[] {
	return names.map((name, index) => ({
		id: `nested-${index}`,
		name,
		args: "{}",
		status: "ok",
	}));
}

function makeCodemodeResult(output: string, nestedToolNames: readonly string[], isError = false) {
	const details: CodemodeToolDetails = { calls: makeNestedCalls(nestedToolNames) };
	return {
		content: [{ type: "text" as const, text: output }],
		details,
		isError,
	};
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
	customCodemodeRenderer?: ToolRenderers;
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
		getRegisteredToolDefinition: (toolName: string) => {
			if (toolName === "codemode") {
				return options?.customCodemodeRenderer ?? codemodeRenderers;
			}
			return withBuiltInRenderers(toolName, undefined);
		},
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

function createCodemodeToolResult(
	id: string,
	output: string,
	nestedToolNames: readonly string[],
	isError = false,
): ToolResultMessage<CodemodeToolDetails> {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "codemode",
		content: [{ type: "text", text: output }],
		details: { calls: makeNestedCalls(nestedToolNames) },
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

describe("CodemodeGroupComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("keeps individual scripts/outputs visible before collapse, then merges into one summary line when collapsed", () => {
		const ui = createFakeTui();
		const group = new CodemodeGroupComponent({ showImages: false }, ui, "/repo");

		const first = group.addCall("c1", { code: "const FIRST_SCRIPT = 1;" }, codemodeRenderers);
		first.updateResult(makeCodemodeResult("FIRST_OUT", ["read", "read", "edit"]));

		const second = group.addCall("c2", { code: "const SECOND_SCRIPT = 2;" }, codemodeRenderers);
		second.updateResult(makeCodemodeResult("SECOND_OUT", ["read", "read", "edit", "edit", "edit", "edit"]));

		// Uncollapsed: both scripts and outputs are rendered normally
		const liveOutput = renderComponent(group);
		expect(liveOutput).toContain("FIRST_SCRIPT");
		expect(liveOutput).toContain("FIRST_OUT");
		expect(liveOutput).toContain("SECOND_SCRIPT");
		expect(liveOutput).toContain("SECOND_OUT");

		// Collapsed: single codemode line with aggregated nested tool counts
		group.setPreviewCollapsed(true);
		const collapsedOutput = renderComponent(group);
		expect(collapsedOutput).toContain("codemode  read·4 edit·5");
		expect(collapsedOutput.match(/codemode/g)).toHaveLength(1);
		expect(collapsedOutput).not.toContain("FIRST_SCRIPT");
		expect(collapsedOutput).not.toContain("SECOND_OUT");
		expect(group.render(120).find((line) => stripAnsi(line).includes("⏺"))).toContain(theme.fg("success", "⏺"));

		// Expand via setExpanded -> full scripts & outputs return; collapse -> back to summary
		group.setExpanded(true);
		const expandedOutput = renderComponent(group);
		expect(expandedOutput).toContain("FIRST_SCRIPT");
		expect(expandedOutput).toContain("SECOND_OUT");

		group.setExpanded(false);
		expect(renderComponent(group)).toContain("codemode  read·4 edit·5");
		expect(renderComponent(group)).not.toContain("FIRST_SCRIPT");

		// Click toggles expanded -> shows full output; second click collapses back to summary
		const width = 120;
		const lines = group.render(width);
		const summaryRow = lines.findIndex((line) => stripAnsi(line).includes("codemode"));
		expect(summaryRow).toBeGreaterThanOrEqual(0);
		const clickEvent: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 4,
			y: summaryRow,
			screenX: 4,
			screenY: summaryRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(group.handleMouse(clickEvent)?.handled).toBe(true);
		expect(renderComponent(group)).toContain("FIRST_SCRIPT");

		expect(group.handleMouse(clickEvent)?.handled).toBe(true);
		expect(renderComponent(group)).toContain("codemode  read·4 edit·5");
		expect(renderComponent(group)).not.toContain("FIRST_SCRIPT");

		group.dispose();
	});

	it("shows bare codemode for single script with no nested calls, ×N for multiple, and red bullet on error", () => {
		const ui = createFakeTui();

		const single = new CodemodeGroupComponent({ showImages: false }, ui, "/repo");
		const h1 = single.addCall("c1", { code: "return 1;" }, codemodeRenderers);
		h1.updateResult(makeCodemodeResult("1", []));
		single.setPreviewCollapsed(true);
		expect(renderComponent(single).trim()).toBe("⏺ codemode");

		const multi = new CodemodeGroupComponent({ showImages: false }, ui, "/repo");
		const m1 = multi.addCall("m1", { code: "return 1;" }, codemodeRenderers);
		const m2 = multi.addCall("m2", { code: "throw new Error('boom');" }, codemodeRenderers);
		m1.updateResult(makeCodemodeResult("1", []));
		m2.updateResult(makeCodemodeResult("boom", [], true));
		multi.setPreviewCollapsed(true);
		expect(renderComponent(multi).trim()).toBe("⏺ codemode  ×2");
		expect(multi.render(120).find((line) => stripAnsi(line).includes("⏺"))).toContain(theme.fg("error", "⏺"));

		single.dispose();
		multi.dispose();
	});
});

describe("InteractiveMode consecutive codemode grouping", () => {
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

	it("keeps consecutive codemode calls unmerged during execution and collapses them into one summary after agent_end", async () => {
		const ctx = createFakeInteractiveContext({ collapseToolOutput: true });

		await handleEvent.call(ctx, { type: "agent_start" });

		// Turn 1: codemode with read x2, bash x1
		const msg1 = createAssistantMessage([
			{ type: "thinking", thinking: "Step 1" },
			{ type: "toolCall", id: "c1", name: "codemode", arguments: { code: "const CM_ONE = 1;" } },
		]);
		await handleEvent.call(ctx, { type: "message_start", message: msg1 });
		await handleEvent.call(ctx, { type: "message_update", message: msg1 } as unknown as AgentSessionEvent);
		await handleEvent.call(ctx, { type: "message_end", message: msg1 });
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "codemode",
			args: { code: "const CM_ONE = 1;" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "codemode",
			result: makeCodemodeResult("OUT_ONE", ["read", "read", "bash"]),
			isError: false,
		});

		// Turn 2: consecutive codemode (hidden thinking only) with read x2, edit x5
		const msg2 = createAssistantMessage([
			{ type: "thinking", thinking: "Step 2" },
			{ type: "toolCall", id: "c2", name: "codemode", arguments: { code: "const CM_TWO = 2;" } },
		]);
		await handleEvent.call(ctx, { type: "message_start", message: msg2 });
		await handleEvent.call(ctx, { type: "message_update", message: msg2 } as unknown as AgentSessionEvent);
		await handleEvent.call(ctx, { type: "message_end", message: msg2 });
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "c2",
			toolName: "codemode",
			args: { code: "const CM_TWO = 2;" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "c2",
			toolName: "codemode",
			result: makeCodemodeResult("OUT_TWO", ["read", "read", "edit", "edit", "edit", "edit", "edit"]),
			isError: false,
		});

		// Before agent_end: not collapsed yet, so scripts/outputs are still shown normally
		const liveChat = renderComponent(ctx.chatContainer);
		expect(liveChat).toContain("CM_ONE");
		expect(liveChat).toContain("CM_TWO");

		// Break continuity with bash, then another codemode
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
			toolCallId: "c3",
			toolName: "codemode",
			args: { code: "const CM_THREE = 3;" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "c3",
			toolName: "codemode",
			result: makeCodemodeResult("OUT_THREE", ["grep"]),
			isError: false,
		});

		await handleEvent.call(ctx, { type: "agent_end", messages: [], willRetry: false });

		const groups = ctx.chatContainer.children.filter((c) => c instanceof CodemodeGroupComponent);
		expect(groups).toHaveLength(2);
		expect(renderComponent(groups[0]!).trim()).toBe("⏺ codemode  read·4 bash·1 edit·5");
		expect(renderComponent(groups[1]!).trim()).toBe("⏺ codemode  grep·1");

		// Ctrl+O expands both groups
		ctx.setToolsExpanded(true);
		const expandedChat = renderComponent(ctx.chatContainer);
		expect(expandedChat).toContain("CM_ONE");
		expect(expandedChat).toContain("CM_TWO");
		expect(expandedChat).toContain("CM_THREE");
	});

	it("groups consecutive historical codemode calls on session replay only when collapsed", () => {
		const entries = createEntries([
			createAssistantMessage([
				{ type: "thinking", thinking: "Step 1" },
				{ type: "toolCall", id: "c1", name: "codemode", arguments: { code: "const H_ONE = 1;" } },
			]),
			createCodemodeToolResult("c1", "H_OUT_1", ["read", "read"]),
			createAssistantMessage([
				{ type: "toolCall", id: "c2", name: "codemode", arguments: { code: "const H_TWO = 2;" } },
			]),
			createCodemodeToolResult("c2", "H_OUT_2", ["read", "edit", "edit"]),
			createAssistantMessage([{ type: "text", text: "Done inspecting." }]),
			createAssistantMessage([
				{ type: "toolCall", id: "c3", name: "codemode", arguments: { code: "const H_THREE = 3;" } },
			]),
			createCodemodeToolResult("c3", "H_OUT_3", ["bash"]),
		]);

		const collapsedCtx = createFakeInteractiveContext({ collapseToolOutput: true });
		renderSessionEntries.call(collapsedCtx, entries);
		const collapsedGroups = collapsedCtx.chatContainer.children.filter((c) => c instanceof CodemodeGroupComponent);
		expect(collapsedGroups).toHaveLength(2);
		expect(renderComponent(collapsedGroups[0]!).trim()).toBe("⏺ codemode  read·3 edit·2");
		expect(renderComponent(collapsedGroups[1]!).trim()).toBe("⏺ codemode  bash·1");
		expect(renderComponent(collapsedCtx.chatContainer)).not.toContain("H_ONE");

		const uncollapsedCtx = createFakeInteractiveContext({ collapseToolOutput: false });
		renderSessionEntries.call(uncollapsedCtx, entries);
		const uncollapsedOutput = renderComponent(uncollapsedCtx.chatContainer);
		expect(uncollapsedOutput).toContain("H_ONE");
		expect(uncollapsedOutput).toContain("H_TWO");
		expect(uncollapsedOutput).toContain("H_THREE");
	});

	it("preserves custom extension codemode renderers via ToolExecutionComponent", async () => {
		const ctx = createFakeInteractiveContext({
			customCodemodeRenderer: {
				renderCall: () => new Text("CUSTOM_CM_CALL", 0, 0),
				renderResult: () => new Text("CUSTOM_CM_RESULT", 0, 0),
			},
		});

		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "codemode",
			args: { code: "return 1;" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "codemode",
			result: makeCodemodeResult("1", ["read"]),
			isError: false,
		});

		expect(ctx.chatContainer.children.some((c) => c instanceof CodemodeGroupComponent)).toBe(false);
		expect(ctx.chatContainer.children.some((c) => c instanceof ToolExecutionComponent)).toBe(true);
		expect(renderComponent(ctx.chatContainer)).toContain("CUSTOM_CM_CALL");
	});
});
