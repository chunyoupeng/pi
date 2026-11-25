import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type Component, Container, type Focusable, type OverlayHandle, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.ts";
import type { QuietStartup } from "../src/core/settings-manager.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import type { AuthSelectorProvider } from "../src/modes/interactive/components/oauth-selector.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

class TestFocusableComponent implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private readonly label: string;
	private text = "";

	constructor(label: string) {
		this.label = label;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

type ExtensionFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.interruptStreaming", () => {
	test("preserves queued messages when interrupting the current response", () => {
		const agent = {
			hasQueuedMessages: vi.fn(() => true),
			abort: vi.fn(),
		};
		const fakeThis = {
			agent,
			restoreQueuedMessagesToEditor: vi.fn(),
		};

		(InteractiveMode as any).prototype.interruptStreaming.call(fakeThis);

		expect(agent.abort).toHaveBeenCalledTimes(1);
		expect(fakeThis.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
	});

	test("restores the queue when no queued agent message can continue", () => {
		const agent = {
			hasQueuedMessages: vi.fn(() => false),
			abort: vi.fn(),
		};
		const fakeThis = {
			agent,
			restoreQueuedMessagesToEditor: vi.fn(),
		};

		(InteractiveMode as any).prototype.interruptStreaming.call(fakeThis);

		expect(fakeThis.restoreQueuedMessagesToEditor).toHaveBeenCalledWith({ abort: true });
		expect(agent.abort).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showManagedToolStatus", () => {
	beforeAll(() => initTheme("dark"));

	test("renders tool updates as one contiguous group", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			managedToolStatusStarted: false,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};
		const showManagedToolStatus = (InteractiveMode as any).prototype.showManagedToolStatus;

		showManagedToolStatus.call(fakeThis, { type: "info", message: "fd downloading" });
		showManagedToolStatus.call(fakeThis, { type: "info", message: "rg downloading" });
		showManagedToolStatus.call(fakeThis, { type: "warning", message: "rg failed" });

		expect(fakeThis.chatContainer.children).toHaveLength(4);
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toBe(
			"fd downloading\n rg downloading\n Warning: rg failed",
		);
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const loadedResourcesChild = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			loadedResourcesContainer: { children: [loadedResourcesChild] },
			chatContainer: { children: [chatChild] },
			pendingMessagesContainer: { children: [] },
			ui: { requestRender: vi.fn() },
			showLoadedResources: vi.fn(),
			showStatus: vi.fn(),
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(fakeThis.showLoadedResources).toHaveBeenCalledWith({ force: true, showDiagnosticsWhenQuiet: true });
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(loadedResourcesChild.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Tool output: expanded");
	});
});

// Regression tests for https://github.com/earendil-works/pi/issues/11875
describe("InteractiveMode pending user bash output", () => {
	function createPendingBashComponent() {
		return { render: () => [], invalidate: () => {}, setExpanded: vi.fn() };
	}

	function createContext(pendingBashComponents: ReturnType<typeof createPendingBashComponent>[]) {
		const pendingMessagesContainer = new Container();
		for (const component of pendingBashComponents) pendingMessagesContainer.addChild(component);
		const fakeThis: any = {
			isInitialized: true,
			toolOutputExpanded: false,
			loadedResourcesContainer: new Container(),
			chatContainer: new Container(),
			pendingMessagesContainer,
			pendingBashComponents,
			compactionQueuedMessages: [],
			session: { getSteeringMessages: () => ["steer"], getFollowUpMessages: () => [] },
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			ui: { requestRender: vi.fn() },
			showLoadedResources: vi.fn(),
			showStatus: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			getAppKeyDisplay: () => "alt+up",
		};
		for (const name of [
			"setToolsExpanded",
			"updatePendingMessagesDisplay",
			"getAllQueuedMessages",
			"flushPendingBashComponents",
			"handleEvent",
		]) {
			fakeThis[name] = (InteractiveMode as any).prototype[name].bind(fakeThis);
		}
		return fakeThis;
	}

	beforeAll(() => {
		initTheme("dark");
	});

	test("ctrl+o expands user bash output in the pending area", () => {
		const component = createPendingBashComponent();
		const fakeThis = createContext([component]);

		fakeThis.setToolsExpanded(true);

		expect(component.setExpanded).toHaveBeenCalledWith(true);
	});

	test("queued message updates keep user bash output in the pending area", () => {
		const component = createPendingBashComponent();
		const fakeThis = createContext([component]);

		fakeThis.updatePendingMessagesDisplay();
		fakeThis.setToolsExpanded(true);

		expect(fakeThis.pendingMessagesContainer.children).toContain(component);
		expect(renderAll(fakeThis.pendingMessagesContainer)).toContain("Steering: steer");
		expect(component.setExpanded).toHaveBeenCalledWith(true);
	});

	test("settling the agent run moves user bash output to the chat", async () => {
		const component = createPendingBashComponent();
		const fakeThis = createContext([component]);

		await fakeThis.handleEvent({ type: "agent_settled", aborted: false });

		expect(fakeThis.pendingMessagesContainer.children).not.toContain(component);
		expect(fakeThis.chatContainer.children).toEqual([component]);
		expect(fakeThis.pendingBashComponents).toEqual([]);
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => {
					fakeThis.ui.requestRender();
					return { success: true };
				}),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("light");
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => ({ success: false, error: "Theme not found" })),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("__missing_theme__");
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showExtensionCustom", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	// Inline custom components go through the extension dialog stack.
	const extensionDialogState = () => ({
		extensionDialogs: [],
		extensionOverlays: new Map(),
		programStatus: { setBlocked: vi.fn() },
		pushExtensionDialog: (InteractiveMode as any).prototype.pushExtensionDialog,
		removeExtensionDialog: (InteractiveMode as any).prototype.removeExtensionDialog,
		showTopExtensionDialog: (InteractiveMode as any).prototype.showTopExtensionDialog,
	});

	test("overlay custom UI reclaims input after non-overlay custom UI closes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui: TUI = new TuiMainScreen(terminal);
		const editorContainer = new Container();
		const editor = new TestFocusableComponent("EDITOR");
		const palette = new TestFocusableComponent("PALETTE");
		const overlay = new TestFocusableComponent("OVERLAY");
		const replacement = new TestFocusableComponent("REPLACEMENT");
		let closeOverlay: (value: string) => void = () => {
			throw new Error("closeOverlay was not initialized");
		};
		let closeReplacement: (value: string) => void = () => {
			throw new Error("closeReplacement was not initialized");
		};
		const fakeThis = {
			editor,
			editorContainer,
			keybindings: {},
			ui,
			disposeActiveSelector: vi.fn(),
			...extensionDialogState(),
		};
		const showExtensionCustom = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T> =>
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory, options) as Promise<T>;

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.addChild(palette);
		ui.setFocus(palette);
		ui.start();
		try {
			const overlayPromise = showExtensionCustom<string>(
				(_tui, _theme, _keybindings, done) => {
					closeOverlay = done;
					return overlay;
				},
				{ overlay: true },
			);
			await flushTui(ui, terminal);
			expect(overlay.focused).toBe(true);

			const replacementPromise = showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
				closeReplacement = done;
				return replacement;
			});
			await flushTui(ui, terminal);
			expect(replacement.focused).toBe(true);

			closeReplacement("done");
			await replacementPromise;
			await flushTui(ui, terminal);
			terminal.sendInput("x");
			await flushTui(ui, terminal);

			expect(overlay.inputs).toEqual(["x"]);
			expect(editor.inputs).toEqual([]);
			expect(overlay.focused).toBe(true);

			closeOverlay("closed");
			await overlayPromise;
		} finally {
			ui.stop();
		}
	});

	// Regression test for #10648: closing a lower overlay removed the topmost overlay instead.
	test.each([
		{ lowerKind: "capturing", nonCapturing: false },
		{ lowerKind: "non-capturing", nonCapturing: true },
	])(
		"closing a lower $lowerKind overlay custom UI removes its own overlay, not the topmost one",
		async ({ nonCapturing }) => {
			const terminal = new VirtualTerminal(80, 24);
			const ui: TUI = new TuiMainScreen(terminal);
			const editorContainer = new Container();
			const editor = new TestFocusableComponent("EDITOR");
			const lower = new TestFocusableComponent("LOWER");
			const upper = new TestFocusableComponent("UPPER");
			let closeLower: (value: string) => void = () => {
				throw new Error("closeLower was not initialized");
			};
			let closeUpper: (value: string) => void = () => {
				throw new Error("closeUpper was not initialized");
			};
			const fakeThis = {
				editor,
				editorContainer,
				keybindings: {},
				ui,
				disposeActiveSelector: vi.fn(),
				...extensionDialogState(),
			};
			const showExtensionCustom = <T>(
				factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
				options?: { overlay?: boolean; overlayOptions?: { nonCapturing?: boolean } },
			): Promise<T> =>
				(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory, options) as Promise<T>;

			editorContainer.addChild(editor);
			ui.addChild(editorContainer);
			ui.setFocus(editor);
			ui.start();
			try {
				const lowerPromise = showExtensionCustom<string>(
					(_tui, _theme, _keybindings, done) => {
						closeLower = done;
						return lower;
					},
					{ overlay: true, overlayOptions: { nonCapturing } },
				);
				await flushTui(ui, terminal);
				const upperPromise = showExtensionCustom<string>(
					(_tui, _theme, _keybindings, done) => {
						closeUpper = done;
						return upper;
					},
					{ overlay: true },
				);
				await flushTui(ui, terminal);
				expect(upper.focused).toBe(true);

				closeLower("lower closed");
				await expect(lowerPromise).resolves.toBe("lower closed");
				await flushTui(ui, terminal);

				const viewport = terminal.getViewport().join("\n");
				expect(viewport).toContain("UPPER");
				expect(viewport).not.toContain("LOWER");
				terminal.sendInput("x");
				await flushTui(ui, terminal);
				expect(upper.inputs).toEqual(["x"]);
				expect(lower.inputs).toEqual([]);

				closeUpper("upper closed");
				await expect(upperPromise).resolves.toBe("upper closed");
				await flushTui(ui, terminal);
				expect(ui.hasOverlay()).toBe(false);
				expect(editor.focused).toBe(true);
			} finally {
				ui.stop();
			}
		},
	);

	// Regression: reset hid only the topmost overlay, so lower extension overlays stayed and kept input.
	test("resetExtensionUI removes every extension overlay but keeps pi's own overlays", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui: TUI = new TuiMainScreen(terminal);
		const editorContainer = new Container();
		const editor = new TestFocusableComponent("EDITOR");
		const internal = new TestFocusableComponent("INTERNAL");
		const lower = Object.assign(new TestFocusableComponent("LOWER"), { dispose: vi.fn() });
		const hidden = Object.assign(new TestFocusableComponent("HIDDEN"), { dispose: vi.fn() });
		const upper = Object.assign(new TestFocusableComponent("UPPER"), { dispose: vi.fn() });
		const fakeThis = {
			editor,
			editorContainer,
			keybindings: {},
			ui,
			disposeActiveSelector: vi.fn(),
			...extensionDialogState(),
			// The rest of resetExtensionUI is not under test here.
			clearExtensionTerminalInputListeners: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			clearExtensionWidgets: vi.fn(),
			footerDataProvider: { clearExtensionStatuses: vi.fn() },
			footer: { invalidate: vi.fn() },
			setCustomEditorComponent: vi.fn(),
			setupAutocompleteProvider: vi.fn(),
			defaultEditor: {},
			updateTerminalTitle: vi.fn(),
			setWorkingIndicator: vi.fn(),
			setHiddenThinkingLabel: vi.fn(),
		};
		const showOverlay = (component: Component, onHandle?: (handle: OverlayHandle) => void): Promise<unknown> =>
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, () => component, {
				overlay: true,
				onHandle,
			}) as Promise<unknown>;

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		ui.start();
		try {
			// A pi-internal overlay (for example the header easter egg) opened below the extension overlays.
			ui.showOverlay(internal);
			void showOverlay(lower);
			void showOverlay(hidden, (handle) => handle.setHidden(true));
			void showOverlay(upper);
			await flushTui(ui, terminal);
			expect(upper.focused).toBe(true);

			(InteractiveMode as any).prototype.resetExtensionUI.call(fakeThis);
			await flushTui(ui, terminal);

			const viewport = terminal.getViewport().join("\n");
			expect(viewport).toContain("INTERNAL");
			expect(viewport).not.toContain("LOWER");
			expect(viewport).not.toContain("UPPER");
			expect(lower.dispose).toHaveBeenCalledOnce();
			expect(hidden.dispose).toHaveBeenCalledOnce();
			expect(upper.dispose).toHaveBeenCalledOnce();
			terminal.sendInput("x");
			await flushTui(ui, terminal);
			expect(internal.inputs).toEqual(["x"]);
			expect(lower.inputs).toEqual([]);

			ui.hideOverlay();
			expect(ui.hasOverlay()).toBe(false);
			expect(editor.focused).toBe(true);
		} finally {
			ui.stop();
		}
	});
});

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});

	test("merges triggerCharacters from wrapper factories", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const passThrough =
			(triggerCharacters: string[]): AutocompleteProviderFactory =>
			(current) => ({
				triggerCharacters,
				getSuggestions: (lines, cursorLine, cursorCol, options) =>
					current.getSuggestions(lines, cursorLine, cursorCol, options),
				applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
					current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [passThrough(["$"]), passThrough(["!"])],
		};

		(
			InteractiveMode as unknown as {
				prototype: { setupAutocompleteProvider: (this: typeof fakeThis) => void };
			}
		).prototype.setupAutocompleteProvider.call(fakeThis);

		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider.triggerCharacters).toEqual(["$", "!"]);
	});
});

describe("InteractiveMode.createBaseAutocompleteProvider", () => {
	test("matches model command arguments across provider/model order", async () => {
		type TestModel = { id: string; provider: string; name: string };
		type FakeInteractiveMode = {
			session: {
				scopedModels: Array<{ model: TestModel }>;
				modelRuntime: { getAvailableSnapshot: () => TestModel[] };
				promptTemplates: [];
				extensionRunner: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: { getEnableSkillCommands: () => boolean };
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
			fdPath: null;
		};

		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: { createBaseAutocompleteProvider(this: FakeInteractiveMode): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		const models = [
			{ id: "gpt-5.2-codex", provider: "github-copilot", name: "GPT-5.2 Codex" },
			{ id: "gpt-5.5", provider: "openai-codex", name: "GPT-5.5" },
		];
		const fakeThis: FakeInteractiveMode = {
			session: {
				scopedModels: [],
				modelRuntime: { getAvailableSnapshot: () => models },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: null,
		};

		const provider = createBaseAutocompleteProvider.call(fakeThis);
		const line = "/model codexgpt";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"openai-codex/gpt-5.5",
			"github-copilot/gpt-5.2-codex",
		]);
	});

	test("matches login command arguments by provider id and name", async () => {
		type FakeInteractiveMode = {
			session: {
				scopedModels: [];
				modelRuntime: { getAvailableSnapshot: () => [] };
				promptTemplates: [];
				extensionRunner: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: { getEnableSkillCommands: () => boolean };
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
			fdPath: null;
			getLoginProviderOptions: () => AuthSelectorProvider[];
		};

		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: { createBaseAutocompleteProvider(this: FakeInteractiveMode): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		const fakeThis: FakeInteractiveMode = {
			session: {
				scopedModels: [],
				modelRuntime: { getAvailableSnapshot: () => [] },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: null,
			getLoginProviderOptions: () => [
				{ id: "anthropic", name: "Anthropic", authType: "oauth", subscription: true },
				{ id: "anthropic", name: "Anthropic", authType: "api_key", subscription: true },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
				{ id: "radius", name: "Radius", authType: "oauth", subscription: false },
			],
		};

		const provider = createBaseAutocompleteProvider.call(fakeThis);
		const line = "/login subscription anthrop";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items).toEqual([
			{
				value: "anthropic",
				label: "anthropic",
				description: "Anthropic · subscription/API key",
			},
		]);

		// OAuth sign-in without a subscription, such as Radius, is an account.
		const radiusLine = "/login radius";
		const radiusSuggestions = await provider.getSuggestions([radiusLine], 0, radiusLine.length, {
			signal: new AbortController().signal,
		});
		expect(radiusSuggestions?.items).toEqual([{ value: "radius", label: "radius", description: "Radius · account" }]);
	});
});
describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: QuietStartup;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		systemPromptSource?: { path: string };
		appendSystemPromptSources?: Array<{ path: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			loadedResourcesContainer: new Container(),
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getSystemPromptSource: () => options.systemPromptSource,
					getAppendSystemPromptSources: () => options.appendSystemPromptSources ?? [],
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			shouldShowStartupDetails: () => (InteractiveMode as any).prototype.shouldShowStartupDetails.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	test("keeps startup resource details in the startup panel instead of duplicating them in chat", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			extensions: [{ path: "/tmp/extensions/answer.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: true });

		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
	});

	test("hides resource listing but keeps the startup header with header-only quiet startup", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: "header",
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
		expect((InteractiveMode as any).prototype.shouldShowStartupHeader.call(fakeThis)).toBe(true);
		expect((InteractiveMode as any).prototype.shouldShowStartupDetails.call(fakeThis)).toBe(false);
	});

	test("hides the startup header with full quiet startup unless verbose", () => {
		const quiet = createShowLoadedResourcesThis({ quietStartup: true });
		expect((InteractiveMode as any).prototype.shouldShowStartupHeader.call(quiet)).toBe(false);
		const verbose = createShowLoadedResourcesThis({ quietStartup: "header", verbose: true });
		expect((InteractiveMode as any).prototype.shouldShowStartupDetails.call(verbose)).toBe(true);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skill warnings]");
		expect(output).not.toContain("[Skills]");
	});
});

describe("InteractiveMode end-of-turn timing status", () => {
	function createHandleEventHarness() {
		const statuses: string[] = [];
		const fakeThis: Record<string, unknown> = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			pendingTools: new Map(),
			turnTools: new Set(),
			addToolOutputDividerBeforeNextAssistant: false,
			defaultEditor: { onEscape: undefined },
			retryEscapeHandler: undefined,
			chatContainer: new Container(),
			ui: {
				requestRender: vi.fn(),
				terminal: { setProgress: vi.fn() },
			},
			settingsManager: {
				getShowTerminalProgress: () => false,
				getCollapseToolOutput: () => false,
			},
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			getMarkdownThemeWithSettings: () => ({}),
			getMarkdownTransformers: () => [],
			updateLiveOutputTokens: vi.fn(),
			updateWorkingOutputTokenLabel: vi.fn(),
			startRequestInputPhase: vi.fn(),
			clearLiveOutputTokens: vi.fn(),
			clearStatusIndicator: vi.fn(),
			hasVisibleAssistantText: () => true,
			addToolOutputDividerBefore: vi.fn(),
			maybeShowThinkingDropNotice: vi.fn(),
			maybeShowCacheMissNotice: vi.fn(),
			showStatus: (message: string) => statuses.push(message),
			agentStartedAt: undefined,
			assistantFirstTokenAt: undefined,
			completedAgentGenerationMs: 0,
			completedAgentOutputTokens: 0,
			streamingComponent: undefined,
			streamingMessage: undefined,
			isFirstOutputTokenEvent: (InteractiveMode as any).prototype.isFirstOutputTokenEvent,
		};
		const handleEvent = (event: unknown) => (InteractiveMode as any).prototype.handleEvent.call(fakeThis, event);
		return { fakeThis, statuses, handleEvent };
	}

	function makeAssistantMessage(output: number) {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 100,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100 + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	}

	test("shows only total time and decode TPS, ignoring empty usage-sync deltas for TPS", async () => {
		initTheme("dark");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		try {
			const { statuses, handleEvent } = createHandleEventHarness();
			const partial = makeAssistantMessage(0);

			await handleEvent({ type: "agent_start" });
			await handleEvent({ type: "message_start", message: partial });
			vi.advanceTimersByTime(1000);
			// Empty delta (e.g. usage sync) must not start the decode timer.
			await handleEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "", partial },
			});
			vi.advanceTimersByTime(2200);
			// Real first output token at t = 3.2s.
			await handleEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan", partial },
			});
			vi.advanceTimersByTime(108_800);
			await handleEvent({ type: "message_end", message: makeAssistantMessage(3850) });
			await handleEvent({ type: "agent_end", messages: [] });

			expect(statuses).toHaveLength(1);
			expect(statuses[0]).toMatch(/^[^·]+ · 1m 52s · 35\.4 tok\/s$/);
		} finally {
			vi.useRealTimers();
		}
	});

	test("excludes tool wait gaps from multi-turn decode TPS", async () => {
		initTheme("dark");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		try {
			const { statuses, handleEvent } = createHandleEventHarness();
			const partial = makeAssistantMessage(0);

			await handleEvent({ type: "agent_start" });

			// Turn 1: TTFT 2.0s, decode 2.0s, 200 tokens.
			await handleEvent({ type: "message_start", message: partial });
			vi.advanceTimersByTime(2000);
			await handleEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
			});
			vi.advanceTimersByTime(2000);
			await handleEvent({ type: "message_end", message: makeAssistantMessage(200) });

			// Tool execution takes 60s.
			vi.advanceTimersByTime(60_000);

			// Turn 2: TTFT 1.5s, decode 8.0s, 800 tokens.
			await handleEvent({ type: "message_start", message: partial });
			vi.advanceTimersByTime(1500);
			await handleEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok", partial },
			});
			vi.advanceTimersByTime(8000);
			await handleEvent({ type: "message_end", message: makeAssistantMessage(800) });
			await handleEvent({ type: "agent_end", messages: [] });

			expect(statuses).toHaveLength(1);
			// Total 73.5s -> 1m 13s, pure decode 1000 / (2s + 8s) = 100.0 tok/s.
			expect(statuses[0]).toMatch(/· 1m 13s · 100\.0 tok\/s$/);
		} finally {
			vi.useRealTimers();
		}
	});

	test("falls back to total elapsed time for sub-100ms single-chunk responses", async () => {
		initTheme("dark");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		try {
			const { statuses, handleEvent } = createHandleEventHarness();
			const partial = makeAssistantMessage(0);

			await handleEvent({ type: "agent_start" });
			await handleEvent({ type: "message_start", message: partial });
			vi.advanceTimersByTime(2000);
			await handleEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial },
			});
			vi.advanceTimersByTime(2);
			await handleEvent({ type: "message_end", message: makeAssistantMessage(20) });
			await handleEvent({ type: "agent_end", messages: [] });

			expect(statuses).toHaveLength(1);
			expect(statuses[0]).toMatch(/· 2s · 10\.0 tok\/s$/);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("InteractiveMode thinking status and live footer context", () => {
	function makeAssistantMessage(
		content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>,
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number },
	) {
		return {
			role: "assistant" as const,
			content,
			api: "antigravity-acp",
			provider: "antigravity-acp",
			model: "gemini-4-neon",
			usage: {
				...usage,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	}

	function createStreamingHarness(thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh", reasoning = true) {
		const tui = { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Pondering");
		const footer = {
			invalidate: vi.fn(),
			setLiveOutputTokens: vi.fn(),
			setLiveContextTokens: vi.fn(),
		};
		const fakeThis: Record<string, unknown> = {
			isInitialized: true,
			session: { thinkingLevel, isStreaming: true, routedModel: undefined, model: { reasoning }, messages: [] },
			footer,
			programStatus: { handleEvent: vi.fn() },
			pendingTools: new Map(),
			turnTools: new Set(),
			addToolOutputDividerBeforeNextAssistant: false,
			defaultEditor: { onEscape: undefined },
			retryEscapeHandler: undefined,
			chatContainer: new Container(),
			ui: tui,
			settingsManager: {
				getShowTerminalProgress: () => false,
				getCollapseToolOutput: () => false,
			},
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			activeStatusIndicator: indicator,
			workingMessage: undefined,
			workingVisible: true,
			defaultWorkingMessage: "Pondering",
			isAssistantThinking: false,
			getMarkdownThemeWithSettings: () => ({}),
			getMarkdownTransformers: () => [],
			getWorkingDetail: (InteractiveMode as any).prototype.getWorkingDetail,
			updateLiveOutputTokens: (InteractiveMode as any).prototype.updateLiveOutputTokens,
			updateWorkingOutputTokenLabel: (InteractiveMode as any).prototype.updateWorkingOutputTokenLabel,
			startRequestInputPhase: (InteractiveMode as any).prototype.startRequestInputPhase,
			clearLiveOutputTokens: (InteractiveMode as any).prototype.clearLiveOutputTokens,
			clearStatusIndicator: vi.fn(),
			hasVisibleAssistantText: () => true,
			addToolOutputDividerBefore: vi.fn(),
			maybeShowThinkingDropNotice: vi.fn(),
			maybeShowCacheMissNotice: vi.fn(),
			showStatus: vi.fn(),
			agentStartedAt: undefined,
			assistantFirstTokenAt: undefined,
			completedAgentGenerationMs: 0,
			completedAgentOutputTokens: 0,
			streamingComponent: undefined,
			streamingMessage: undefined,
			isFirstOutputTokenEvent: (InteractiveMode as any).prototype.isFirstOutputTokenEvent,
		};
		const handleEvent = (event: unknown) => (InteractiveMode as any).prototype.handleEvent.call(fakeThis, event);
		return { fakeThis, indicator, footer, handleEvent };
	}

	test.each([
		["low", "still thinking with low effort"],
		["medium", "still thinking with medium effort"],
		["high", "still thinking with high effort"],
		["xhigh", "still thinking with xhigh effort"],
	] as const)(
		"keeps default working message in front and appends '%s' thinking effort suffix only while thinking tokens stream",
		async (level, expectedDetail) => {
			initTheme("dark");
			const { fakeThis, indicator, handleEvent } = createStreamingHarness(level, true);
			try {
				const initial = makeAssistantMessage([], {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
				});
				await handleEvent({ type: "agent_start" });
				fakeThis.defaultWorkingMessage = "Pondering";
				await handleEvent({ type: "turn_start" });
				expect(stripAnsi(indicator.render(120).join("\n"))).toContain("Pondering");
				expect(stripAnsi(indicator.render(120).join("\n"))).not.toContain("still thinking");

				await handleEvent({ type: "message_start", message: initial });
				expect(stripAnsi(indicator.render(120).join("\n"))).toContain("Pondering (");
				expect(stripAnsi(indicator.render(120).join("\n"))).not.toContain("still thinking");

				// Bare thinking_start and empty usage-sync deltas before any token must keep the suffix absent.
				await handleEvent({
					type: "message_update",
					message: initial,
					assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: initial },
				});
				await handleEvent({
					type: "message_update",
					message: initial,
					assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "", partial: initial },
				});
				await handleEvent({
					type: "message_update",
					message: initial,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: initial },
				});
				expect(stripAnsi(indicator.render(120).join("\n"))).toContain("Pondering (");
				expect(stripAnsi(indicator.render(120).join("\n"))).not.toContain("still thinking");

				// First real thinking token keeps "Pondering" in front and appends " · still thinking with <level> effort".
				const firstThinkingMsg = makeAssistantMessage([{ type: "thinking", thinking: "plan" }], {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
				});
				await handleEvent({
					type: "message_update",
					message: firstThinkingMsg,
					assistantMessageEvent: {
						type: "thinking_delta",
						contentIndex: 0,
						delta: "plan",
						partial: firstThinkingMsg,
					},
				});
				expect(stripAnsi(indicator.render(120).join("\n"))).toMatch(
					new RegExp(`Pondering \\([^)]+ · ${expectedDetail}\\)`),
				);

				// Empty text delta (usage sync) keeps thinking detail active once thinking started.
				await handleEvent({
					type: "message_update",
					message: firstThinkingMsg,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: firstThinkingMsg },
				});
				expect(stripAnsi(indicator.render(120).join("\n"))).toMatch(
					new RegExp(`Pondering \\([^)]+ · ${expectedDetail}\\)`),
				);

				// Text output removes the thinking detail while keeping the front working message.
				const textMsg = makeAssistantMessage([{ type: "text", text: "Answer" }], {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
				});
				await handleEvent({
					type: "message_update",
					message: textMsg,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Answer", partial: textMsg },
				});
				expect(stripAnsi(indicator.render(120).join("\n"))).toContain("Pondering (");
				expect(stripAnsi(indicator.render(120).join("\n"))).not.toContain("still thinking");

				// Explicit thinking delta later in the turn re-activates the thinking suffix.
				const thinkingMsg = makeAssistantMessage([{ type: "thinking", thinking: "more" }], {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
				});
				await handleEvent({
					type: "message_update",
					message: thinkingMsg,
					assistantMessageEvent: {
						type: "thinking_delta",
						contentIndex: 0,
						delta: "more",
						partial: thinkingMsg,
					},
				});
				expect(stripAnsi(indicator.render(120).join("\n"))).toMatch(
					new RegExp(`Pondering \\([^)]+ · ${expectedDetail}\\)`),
				);

				// Tool calls and thinking_end immediately drop the thinking suffix while keeping the front label.
				await handleEvent({
					type: "message_update",
					message: thinkingMsg,
					assistantMessageEvent: {
						type: "thinking_end",
						contentIndex: 0,
						content: "more",
						partial: thinkingMsg,
					},
				});
				expect(stripAnsi(indicator.render(120).join("\n"))).toContain("Pondering (");
				expect(stripAnsi(indicator.render(120).join("\n"))).not.toContain("still thinking");

				await handleEvent({
					type: "message_update",
					message: thinkingMsg,
					assistantMessageEvent: {
						type: "thinking_delta",
						contentIndex: 0,
						delta: "again",
						partial: thinkingMsg,
					},
				});
				expect(stripAnsi(indicator.render(120).join("\n"))).toMatch(
					new RegExp(`Pondering \\([^)]+ · ${expectedDetail}\\)`),
				);

				await handleEvent({
					type: "message_update",
					message: thinkingMsg,
					assistantMessageEvent: {
						type: "toolcall_start",
						contentIndex: 1,
						partial: thinkingMsg,
					},
				});
				expect(stripAnsi(indicator.render(120).join("\n"))).toContain("Pondering (");
				expect(stripAnsi(indicator.render(120).join("\n"))).not.toContain("still thinking");

				// Starting a subsequent turn waits for the next first token without the thinking suffix.
				await handleEvent({ type: "turn_start" });
				expect(stripAnsi(indicator.render(120).join("\n"))).toContain("Pondering");
				expect(stripAnsi(indicator.render(120).join("\n"))).not.toContain("still thinking");
			} finally {
				indicator.dispose();
			}
		},
	);

	test("keeps default working message when thinking is off unless real thinking tokens stream", async () => {
		initTheme("dark");
		const { fakeThis, indicator, handleEvent } = createStreamingHarness("off", true);
		try {
			const initial = makeAssistantMessage([], {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			});
			await handleEvent({ type: "agent_start" });
			fakeThis.defaultWorkingMessage = "Pondering";
			await handleEvent({ type: "turn_start" });
			await handleEvent({ type: "message_start", message: initial });
			expect(stripAnsi(indicator.render(120).join("\n"))).toContain("Pondering (");
			expect(stripAnsi(indicator.render(120).join("\n"))).not.toContain("still thinking");

			// Empty usage-sync thinking delta must not trigger thinking suffix.
			await handleEvent({
				type: "message_update",
				message: initial,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "", partial: initial },
			});
			expect(stripAnsi(indicator.render(120).join("\n"))).not.toContain("still thinking");

			// Real thinking delta appends generic " · still thinking" while keeping "Pondering" in front.
			const thinkingMsg = makeAssistantMessage([{ type: "thinking", thinking: "analyzing" }], {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			});
			await handleEvent({
				type: "message_update",
				message: thinkingMsg,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "analyzing",
					partial: thinkingMsg,
				},
			});
			expect(stripAnsi(indicator.render(120).join("\n"))).toMatch(/Pondering \([^)]+ · still thinking\)/);
		} finally {
			indicator.dispose();
		}
	});

	test("pushes live context tokens to the footer across streaming updates and clears them on end", async () => {
		initTheme("dark");
		const { indicator, footer, handleEvent } = createStreamingHarness("high");
		try {
			const startMsg = makeAssistantMessage([], {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			});
			await handleEvent({ type: "agent_start" });
			await handleEvent({ type: "message_start", message: startMsg });
			expect(footer.setLiveContextTokens).toHaveBeenLastCalledWith(undefined);

			// Multi-step ACP usage update: totalTokens is the live context window fill, output is cumulative.
			const step1 = makeAssistantMessage([{ type: "thinking", thinking: "plan" }], {
				input: 10_000,
				output: 1_200,
				cacheRead: 40_000,
				cacheWrite: 0,
				totalTokens: 50_500,
			});
			await handleEvent({
				type: "message_update",
				message: step1,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "", partial: step1 },
			});
			expect(footer.setLiveContextTokens).toHaveBeenLastCalledWith(50_500);

			// Single-step provider (e.g. Anthropic): message_start has input + small output=3 while thinking streams 4000 chars.
			const anthropicStreaming = makeAssistantMessage([{ type: "thinking", thinking: "x".repeat(4000) }], {
				input: 100,
				output: 3,
				cacheRead: 50_000,
				cacheWrite: 2_000,
				totalTokens: 52_103,
			});
			await handleEvent({
				type: "message_update",
				message: anthropicStreaming,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "x",
					partial: anthropicStreaming,
				},
			});
			expect(footer.setLiveContextTokens).toHaveBeenLastCalledWith(53_100);

			await handleEvent({ type: "message_end", message: step1 });
			expect(footer.setLiveContextTokens).toHaveBeenLastCalledWith(undefined);
		} finally {
			indicator.dispose();
		}
	});

	test("shows the request's prompt size with an up arrow until the first output token, then output with a down arrow", async () => {
		initTheme("dark");
		const { fakeThis, indicator, handleEvent } = createStreamingHarness("off", false);
		try {
			const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
			const history = makeAssistantMessage([{ type: "text", text: "earlier" }], {
				input: 50_000,
				output: 2_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 52_000,
			});
			(fakeThis.session as { messages: unknown[] }).messages = [history];
			const label = () => stripAnsi(indicator.render(120).join("\n"));

			await handleEvent({ type: "agent_start" });
			await handleEvent({ type: "turn_start" });
			expect(label()).toContain("↑ 52k tokens");

			const streaming = makeAssistantMessage([{ type: "text", text: "x".repeat(400) }], empty);
			await handleEvent({ type: "message_start", message: makeAssistantMessage([], empty) });
			expect(label()).toContain("↑ 52k tokens");

			await handleEvent({
				type: "message_update",
				message: streaming,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: streaming },
			});
			expect(label()).toContain("↓ 100 tokens");
		} finally {
			indicator.dispose();
		}
	});
});
