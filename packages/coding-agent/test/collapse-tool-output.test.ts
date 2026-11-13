import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
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

describe("ToolExecutionComponent preview collapsing", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("keeps call line and hides result preview for read, bash, codemode, and fallback tools", () => {
		const ui = createFakeTui();

		const readTool = new ToolExecutionComponent(
			"read",
			"call-read",
			{ path: "src/app.ts" },
			{ showImages: false },
			withBuiltInRenderers("read", undefined),
			ui,
			"/repo",
		);
		readTool.updateResult({ content: [{ type: "text", text: "READ_BODY_LINE" }], isError: false });
		expect(renderComponent(readTool)).toContain("Read(src/app.ts)");
		expect(renderComponent(readTool)).toContain("READ_BODY_LINE");
		readTool.setPreviewCollapsed(true);
		expect(renderComponent(readTool)).toContain("Read(src/app.ts)");
		expect(renderComponent(readTool)).not.toContain("READ_BODY_LINE");

		const bashTool = new ToolExecutionComponent(
			"bash",
			"call-bash",
			{ command: "echo hi" },
			{ showImages: false },
			withBuiltInRenderers("bash", undefined),
			ui,
			"/repo",
		);
		bashTool.updateResult({ content: [{ type: "text", text: "BASH_OUTPUT_LINE" }], isError: false });
		expect(renderComponent(bashTool)).toContain("Bash(echo hi)");
		expect(renderComponent(bashTool)).toContain("BASH_OUTPUT_LINE");
		bashTool.setPreviewCollapsed(true);
		expect(renderComponent(bashTool)).toContain("Bash(echo hi)");
		expect(renderComponent(bashTool)).not.toContain("BASH_OUTPUT_LINE");

		const codemodeTool = new ToolExecutionComponent(
			"codemode",
			"call-codemode",
			{ code: "const CODEMODE_SCRIPT = 1;" },
			{ showImages: false },
			codemodeRenderers,
			ui,
			"/repo",
		);
		codemodeTool.updateResult({
			content: [{ type: "text", text: "CODEMODE_RESULT_OUTPUT" }],
			isError: false,
		});
		expect(renderComponent(codemodeTool)).toContain("codemode");
		expect(renderComponent(codemodeTool)).toContain("CODEMODE_SCRIPT");
		expect(renderComponent(codemodeTool)).toContain("CODEMODE_RESULT_OUTPUT");
		codemodeTool.setPreviewCollapsed(true);
		expect(renderComponent(codemodeTool)).toContain("codemode");
		expect(renderComponent(codemodeTool)).not.toContain("CODEMODE_SCRIPT");
		expect(renderComponent(codemodeTool)).not.toContain("CODEMODE_RESULT_OUTPUT");

		const fallbackTool = new ToolExecutionComponent(
			"custom_plain",
			"call-fallback",
			{ target: "foo" },
			{ showImages: false },
			undefined,
			ui,
			"/repo",
		);
		fallbackTool.updateResult({ content: [{ type: "text", text: "FALLBACK_OUTPUT" }], isError: false });
		expect(renderComponent(fallbackTool)).toContain("FALLBACK_OUTPUT");
		fallbackTool.setPreviewCollapsed(true);
		expect(renderComponent(fallbackTool)).toContain('custom_plain target="foo"');
		expect(renderComponent(fallbackTool)).not.toContain("FALLBACK_OUTPUT");
	});

	it("hides error output too and restores full output when expanded or clicked", () => {
		const ui = createFakeTui();
		const tool = new ToolExecutionComponent(
			"bash",
			"call-err",
			{ command: "false" },
			{ showImages: false },
			withBuiltInRenderers("bash", undefined),
			ui,
			"/repo",
		);
		tool.updateResult({ content: [{ type: "text", text: "ERROR_DETAIL_LINE" }], isError: true });
		tool.setPreviewCollapsed(true);
		expect(renderComponent(tool)).toContain("Bash(false)");
		expect(renderComponent(tool)).not.toContain("ERROR_DETAIL_LINE");

		// Clicking toggles expanded -> reveals output; clicking again hides preview again.
		const width = 120;
		const lines = tool.render(width);
		const callRow = lines.findIndex((line) => stripAnsi(line).includes("Bash(false)"));
		expect(callRow).toBeGreaterThanOrEqual(0);
		const clickEvent: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 2,
			y: callRow,
			screenX: 2,
			screenY: callRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(tool.handleMouse(clickEvent)?.handled).toBe(true);
		expect(renderComponent(tool)).toContain("ERROR_DETAIL_LINE");

		expect(tool.handleMouse(clickEvent)?.handled).toBe(true);
		expect(renderComponent(tool)).not.toContain("ERROR_DETAIL_LINE");

		// Global expand overrides previewCollapsed; global collapse returns to hidden preview.
		tool.setExpanded(true);
		expect(renderComponent(tool)).toContain("ERROR_DETAIL_LINE");
		tool.setExpanded(false);
		expect(renderComponent(tool)).not.toContain("ERROR_DETAIL_LINE");
	});
});

type FakeInteractiveContext = {
	pendingTools: Map<string, ToolExecutionComponent>;
	turnTools: Set<ToolExecutionComponent>;
	chatContainer: Container;
	loadedResourcesContainer: Container;
	footer: { invalidate(): void };
	programStatus: { handleEvent(): void };
	ui: TUI;
	settingsManager: SettingsManager;
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: { retryAttempt: number; modelRuntime: { getAvailableSnapshot(): unknown[] } };
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	streamingComponent: undefined;
	streamingMessage: undefined;
	agentStartedAt: number | undefined;
	completedAgentOutputTokens: number;
	defaultWorkingMessage: string;
	addToolOutputDividerBeforeNextAssistant: boolean;
	retryEscapeHandler: undefined;
	customHeader: undefined;
	builtInHeader: undefined;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): ReturnType<typeof withBuiltInRenderers>;
	addMessageToChat(message: AgentMessage): void;
	renderSessionItems: (items: AgentMessage[]) => void;
	clearStatusIndicator(kind?: string): void;
	clearLiveOutputTokens(): void;
	showStatus(message: string): void;
	showLoadedResources(options?: { force?: boolean; showDiagnosticsWhenQuiet?: boolean }): void;
	setToolsExpanded: (expanded: boolean) => void;
	maybeShowInstallChangeWarning(): void;
};

function createFakeInteractiveContext(settings?: { collapseToolOutput?: boolean }): FakeInteractiveContext {
	const chatContainer = new Container();
	const settingsManager = SettingsManager.inMemory(settings);
	const proto = InteractiveMode.prototype as unknown as {
		renderSessionItems: (items: AgentMessage[]) => void;
		setToolsExpanded: (expanded: boolean) => void;
	};
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		turnTools: new Set<ToolExecutionComponent>(),
		chatContainer,
		loadedResourcesContainer: new Container(),
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: createFakeTui(),
		settingsManager,
		sessionManager: { getCwd: () => "/repo", getEntries: () => [] },
		session: { retryAttempt: 0, modelRuntime: { getAvailableSnapshot: () => [] } },
		toolOutputExpanded: false,
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
		getRegisteredToolDefinition: (toolName: string) => withBuiltInRenderers(toolName, undefined),
		addMessageToChat: vi.fn(),
		renderSessionItems: proto.renderSessionItems,
		clearStatusIndicator: vi.fn(),
		clearLiveOutputTokens: vi.fn(),
		showStatus: vi.fn(),
		showLoadedResources: vi.fn(),
		setToolsExpanded: proto.setToolsExpanded,
		maybeShowInstallChangeWarning: vi.fn(),
	};
}

function createAssistantToolCall(
	id: string,
	name = "bash",
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { command: "echo ok" } }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

function createToolResult(id: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
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

describe("InteractiveMode auto-collapse tool output", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("defaults collapseToolOutput setting to true and persists changes", () => {
		const settingsManager = SettingsManager.inMemory();
		expect(settingsManager.getCollapseToolOutput()).toBe(true);
		settingsManager.setCollapseToolOutput(false);
		expect(settingsManager.getCollapseToolOutput()).toBe(false);
	});

	it("keeps preview visible during tool calls and collapses after agent_end without retry", async () => {
		const ctx = createFakeInteractiveContext();
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent: (this: FakeInteractiveContext, event: AgentSessionEvent) => Promise<void>;
			}
		).handleEvent;

		await handleEvent.call(ctx, { type: "agent_start" });
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo live" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "LIVE_OUTPUT" }], details: undefined },
			isError: true,
		});

		// Still in the turn before agent_end -> preview stays visible even after tool_execution_end.
		expect(renderComponent(ctx.chatContainer)).toContain("LIVE_OUTPUT");

		// Auto-retry agent_end does not collapse yet.
		await handleEvent.call(ctx, { type: "agent_end", messages: [], willRetry: true });
		expect(renderComponent(ctx.chatContainer)).toContain("LIVE_OUTPUT");

		// Final agent_end collapses preview (including errored tools), while keeping edit and write uncollapsed.
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "t-edit",
			toolName: "edit",
			args: { path: "src/edit.ts", oldText: "a", newText: "b" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "t-edit",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "Updated" }],
				details: { diff: "-1 a\n+1 LIVE_EDIT_DIFF" },
			},
			isError: false,
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "t-write",
			toolName: "write",
			args: { path: "src/new.ts", content: "export const LIVE_WRITE_BODY = 1;" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "t-write",
			toolName: "write",
			result: { content: [{ type: "text", text: "Wrote" }], details: undefined },
			isError: false,
		});

		await handleEvent.call(ctx, { type: "agent_end", messages: [], willRetry: false });
		const finalOutput = renderComponent(ctx.chatContainer);
		expect(finalOutput).toContain("Bash(echo live)");
		expect(finalOutput).not.toContain("LIVE_OUTPUT");
		expect(finalOutput).toContain("Edit(src/edit.ts)");
		expect(finalOutput).toContain("LIVE_EDIT_DIFF");
		expect(finalOutput).toContain("Write(src/new.ts)");
		expect(finalOutput).toContain("LIVE_WRITE_BODY");
	});

	it("keeps tools expanded across turns when globally expanded, then collapses on global collapse", async () => {
		const ctx = createFakeInteractiveContext();
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent: (this: FakeInteractiveContext, event: AgentSessionEvent) => Promise<void>;
			}
		).handleEvent;

		ctx.setToolsExpanded(true);

		await handleEvent.call(ctx, { type: "agent_start" });
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo first" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "FIRST_EXPANDED" }], details: undefined },
			isError: false,
		});
		await handleEvent.call(ctx, { type: "agent_end", messages: [], willRetry: false });
		expect(renderComponent(ctx.chatContainer)).toContain("FIRST_EXPANDED");

		// Subsequent turn also stays expanded after completion.
		await handleEvent.call(ctx, { type: "agent_start" });
		await handleEvent.call(ctx, {
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "bash",
			args: { command: "echo second" },
		});
		await handleEvent.call(ctx, {
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "SECOND_EXPANDED" }], details: undefined },
			isError: false,
		});
		await handleEvent.call(ctx, { type: "agent_end", messages: [], willRetry: false });
		expect(renderComponent(ctx.chatContainer)).toContain("SECOND_EXPANDED");

		// Global collapse hides previews on finished turns.
		ctx.setToolsExpanded(false);
		expect(renderComponent(ctx.chatContainer)).not.toContain("FIRST_EXPANDED");
		expect(renderComponent(ctx.chatContainer)).not.toContain("SECOND_EXPANDED");
	});

	it("collapses completed historical tools on resume except edit and write, and respects collapseToolOutput=false", () => {
		const editCall: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "h-edit",
					name: "edit",
					arguments: { path: "src/edit.ts", oldText: "a", newText: "b" },
				},
			],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: EMPTY_USAGE,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const editResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "h-edit",
			toolName: "edit",
			content: [{ type: "text", text: "Updated" }],
			details: { diff: "-1 a\n+1 RESUMED_EDIT_DIFF" },
			isError: false,
			timestamp: Date.now(),
		};
		const writeCall: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "h-write",
					name: "write",
					arguments: { path: "src/write.ts", content: "export const RESUMED_WRITE_BODY = 1;" },
				},
			],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: EMPTY_USAGE,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const writeResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "h-write",
			toolName: "write",
			content: [{ type: "text", text: "Wrote" }],
			isError: false,
			timestamp: Date.now(),
		};
		const entries = createEntries([
			createAssistantToolCall("h1"),
			createToolResult("h1", "RESUMED_OK_OUTPUT", false),
			createAssistantToolCall("h2"),
			createToolResult("h2", "RESUMED_ERR_OUTPUT", true),
			createAssistantToolCall("h3", "bash", "error"),
			editCall,
			editResult,
			writeCall,
			writeResult,
		]);

		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as {
				renderSessionEntries: (this: FakeInteractiveContext, entries: SessionEntry[]) => void;
			}
		).renderSessionEntries;

		const collapsedCtx = createFakeInteractiveContext({ collapseToolOutput: true });
		renderSessionEntries.call(collapsedCtx, entries);
		const collapsedOutput = renderComponent(collapsedCtx.chatContainer);
		expect(collapsedOutput).toContain("Bash(echo ok)");
		expect(collapsedOutput).not.toContain("RESUMED_OK_OUTPUT");
		expect(collapsedOutput).not.toContain("RESUMED_ERR_OUTPUT");
		expect(collapsedOutput).toContain("RESUMED_EDIT_DIFF");
		expect(collapsedOutput).toContain("RESUMED_WRITE_BODY");

		const previewCtx = createFakeInteractiveContext({ collapseToolOutput: false });
		renderSessionEntries.call(previewCtx, entries);
		const previewOutput = renderComponent(previewCtx.chatContainer);
		expect(previewOutput).toContain("RESUMED_OK_OUTPUT");
		expect(previewOutput).toContain("RESUMED_ERR_OUTPUT");
	});
});
