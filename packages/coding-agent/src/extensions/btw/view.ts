/**
 * Fullscreen continuous side conversation component for /btw.
 *
 * Renders a full terminal overlay featuring:
 * - Native header and theme styling matching the main window
 * - Scrollable transcript containing isolated multi-turn Q&A
 * - Native UserMessageComponent and AssistantMessageComponent reuse
 * - Multiline input editor at bottom with cursor-aware sizing and tiny terminal adaptation
 * - Configurable keybindings: Ctrl+C cancels ONLY side stream, Esc returns to main
 * - Thinking expansion shortcut (app.thinking.toggle) applied to all assistant components
 * - Cancels ongoing side request on exit to prevent hidden costs
 * - Queueing while busy to prevent corruption
 * - Proper disposal and focus listener cleanup
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type Focusable,
	type Keybinding,
	type KeybindingsManager,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { formatKeyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import { getEditorTheme, getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import {
	createFallbackAssistantMessage,
	runSideQuestionStream,
	type SideThread,
	type StreamStatus,
} from "./side-thread.ts";

export interface BtwViewOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	thread: SideThread;
	model?: Model<Api>;
	modelRegistry: ExtensionCommandContext["modelRegistry"];
	thinkingLevel?: string;
	initialQuestion?: string;
	onDone: () => void;
}

interface CommittedTurnComponent {
	question: string;
	answer: string;
	userComp: UserMessageComponent;
	asstComp: AssistantMessageComponent;
}

function createModelFallback(model?: Model<Api>): Model<Api> {
	if (model) return model;
	return {
		id: "model",
		name: "Model",
		provider: "provider",
		baseUrl: "",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function makeAssistantMessage(text: string, model?: Model<Api>, thinking?: string): AssistantMessage {
	const effectiveModel = createModelFallback(model);
	const content: AssistantMessage["content"] = [];
	if (thinking) {
		content.push({ type: "thinking", thinking });
	}
	content.push({ type: "text", text });
	return {
		role: "assistant",
		content,
		api: effectiveModel.api,
		provider: effectiveModel.provider,
		model: effectiveModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export class BtwView implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly thread: SideThread;
	private readonly model?: Model<Api>;
	private readonly modelRegistry: ExtensionCommandContext["modelRegistry"];
	private readonly thinkingLevel?: string;
	private readonly onDone: () => void;

	private readonly editor: Editor;
	private readonly committedTurns: CommittedTurnComponent[] = [];

	private activeUserComp?: UserMessageComponent;
	private activeAsstComp?: AssistantMessageComponent;
	private activeQuestion?: string;
	private activeAbortController?: AbortController;
	private currentStreamingText = "";
	private currentRequestId = 0;
	private nextRequestId = 0;

	private isBusy = false;
	private status: StreamStatus | "idle" = "idle";
	private queue: string[] = [];
	private scrollOffset = 0;
	private autoScroll = true;
	private disposed = false;
	private lastTranscriptHeight = 10;
	private outputPad = 1;
	private thinkingExpanded = false;

	constructor(options: BtwViewOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.thread = options.thread;
		this.model = options.model;
		this.modelRegistry = options.modelRegistry;
		this.thinkingLevel = options.thinkingLevel;
		this.onDone = options.onDone;

		const editorTheme = getEditorTheme();
		this.editor = new Editor(this.tui, editorTheme, {
			promptPrefix: "❯ ",
			paddingX: 1,
		});
		this.editor.focused = true;
		this.editor.onSubmit = (text) => {
			void this.submit(text);
		};

		// Rebuild turn components for retained thread history
		const mdTheme = getMarkdownTheme();
		const effectiveModel = createModelFallback(this.model);
		for (const turn of this.thread.turns) {
			const userComp = new UserMessageComponent(turn.question, mdTheme, this.outputPad);
			const asstMsg = turn.response ?? createFallbackAssistantMessage(turn.answer, effectiveModel);
			const asstComp = new AssistantMessageComponent(asstMsg, false, mdTheme, "Thinking...", this.outputPad);
			asstComp.setExpanded(this.thinkingExpanded);
			this.committedTurns.push({
				question: turn.question,
				answer: turn.answer,
				userComp,
				asstComp,
			});
		}

		// If an initial question was provided at invocation, submit it
		if (options.initialQuestion?.trim()) {
			queueMicrotask(() => {
				if (!this.disposed) {
					void this.submit(options.initialQuestion!);
				}
			});
		}
	}

	get focused(): boolean {
		return this.editor.focused;
	}

	set focused(value: boolean) {
		this.editor.focused = value;
	}

	invalidate(): void {
		this.editor.invalidate();
		for (const turn of this.committedTurns) {
			turn.userComp.invalidate();
			turn.asstComp.invalidate();
		}
		this.activeUserComp?.invalidate();
		this.activeAsstComp?.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		if (this.activeAbortController) {
			this.activeAbortController.abort();
			this.activeAbortController = undefined;
		}
		this.queue = [];
		this.editor.dispose();
	}

	private matchesCancel(data: string): boolean {
		if (this.keybindings.matches(data, "app.btw.cancel")) return true;
		if (this.keybindings.getDefinition?.("app.btw.cancel") === undefined) {
			return this.keybindings.matches(data, "app.clear");
		}
		return false;
	}

	private matchesClose(data: string): boolean {
		if (this.keybindings.matches(data, "app.btw.close")) return true;
		if (this.keybindings.getDefinition?.("app.btw.close") === undefined) {
			return this.keybindings.matches(data, "app.interrupt") || this.keybindings.matches(data, "tui.select.cancel");
		}
		return false;
	}

	private matchesExpand(data: string): boolean {
		return (
			this.keybindings.matches(data, "app.tools.expand") || this.keybindings.matches(data, "app.thinking.toggle")
		);
	}

	handleInput(data: string): void {
		// 1. Check Return to Main (Esc)
		if (this.matchesClose(data)) {
			this.handleClose();
			return;
		}

		// 2. Check Cancel side stream (Ctrl+C)
		if (this.matchesCancel(data)) {
			this.handleCancel();
			return;
		}

		// 3. Toggle thinking expansion (app.tools.expand / app.thinking.toggle)
		if (this.matchesExpand(data)) {
			this.toggleThinkingExpansion();
			return;
		}

		// 4. Scroll transcript keys
		if (
			this.keybindings.matches(data, "tui.altScreen.pageUp") ||
			this.keybindings.matches(data, "tui.select.pageUp")
		) {
			this.scrollBy(-Math.max(1, this.lastTranscriptHeight - 2));
			return;
		}
		if (
			this.keybindings.matches(data, "tui.altScreen.pageDown") ||
			this.keybindings.matches(data, "tui.select.pageDown")
		) {
			this.scrollBy(Math.max(1, this.lastTranscriptHeight - 2));
			return;
		}

		// 5. Multiline editor input
		this.editor.handleInput(data);
	}

	private toggleThinkingExpansion(): void {
		this.thinkingExpanded = !this.thinkingExpanded;
		for (const turn of this.committedTurns) {
			turn.asstComp.setExpanded(this.thinkingExpanded);
		}
		if (this.activeAsstComp) {
			this.activeAsstComp.setExpanded(this.thinkingExpanded);
		}
		this.tui.requestRender();
	}

	private scrollBy(delta: number): void {
		const nextOffset = this.scrollOffset + delta;
		this.scrollOffset = Math.max(0, nextOffset);
		this.autoScroll = false;
		this.tui.requestRender();
	}

	private handleCancel(): void {
		if (this.isBusy) {
			// Cancels ONLY the side request; main task is untouched
			if (this.activeAbortController) {
				this.activeAbortController.abort();
				this.activeAbortController = undefined;
			}
			this.queue = [];
			this.status = "cancelled";

			const text = this.currentStreamingText ? `${this.currentStreamingText}\n\n(Cancelled)` : "(Request cancelled)";
			const msg = makeAssistantMessage(text, this.model);
			if (this.activeAsstComp) {
				this.activeAsstComp.updateContent(msg, false);
				this.activeAsstComp.setStreaming(false);
			}
			if (this.activeQuestion && this.activeUserComp && this.activeAsstComp) {
				this.commitTurn(this.activeQuestion, text, msg, this.activeUserComp, this.activeAsstComp);
			}

			this.isBusy = false;
			this.activeUserComp = undefined;
			this.activeAsstComp = undefined;
			this.activeQuestion = undefined;
			this.currentStreamingText = "";
			this.tui.requestRender();
		} else {
			// Clear editor text when not busy
			if (this.editor.getText().length > 0) {
				this.editor.setText("");
				this.tui.requestRender();
			}
		}
	}

	private handleClose(): void {
		// Cancel ongoing side request on exit to avoid hidden costs
		if (this.isBusy && this.activeAbortController) {
			this.activeAbortController.abort();
			this.activeAbortController = undefined;
			if (this.activeQuestion && this.activeUserComp && this.activeAsstComp) {
				const text = this.currentStreamingText
					? `${this.currentStreamingText}\n\n(Cancelled)`
					: "(Request cancelled)";
				const msg = makeAssistantMessage(text, this.model);
				this.commitTurn(this.activeQuestion, text, msg, this.activeUserComp, this.activeAsstComp);
			}
		}
		this.queue = [];
		this.isBusy = false;
		this.onDone();
	}

	private async submit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;

		if (this.isBusy) {
			// While busy, queue rather than corrupt
			this.queue.push(trimmed);
			this.editor.setText("");
			this.tui.requestRender();
			return;
		}

		this.editor.setText("");
		this.autoScroll = true;
		await this.executeQuestion(trimmed);
	}

	private commitTurn(
		question: string,
		answer: string,
		response?: AssistantMessage,
		userComp?: UserMessageComponent,
		asstComp?: AssistantMessageComponent,
	): void {
		const mdTheme = getMarkdownTheme();
		const effectiveModel = createModelFallback(this.model);
		const finalUser = userComp ?? new UserMessageComponent(question, mdTheme, this.outputPad);
		const finalAsst =
			asstComp ??
			new AssistantMessageComponent(
				response ?? createFallbackAssistantMessage(answer, effectiveModel),
				false,
				mdTheme,
				"Thinking...",
				this.outputPad,
			);
		finalAsst.setExpanded(this.thinkingExpanded);

		this.thread.turns.push({
			question,
			answer,
			response,
		});

		this.committedTurns.push({
			question,
			answer,
			userComp: finalUser,
			asstComp: finalAsst,
		});
	}

	private async executeQuestion(question: string): Promise<void> {
		if (this.disposed) return;

		this.isBusy = true;
		this.status = "thinking";
		this.currentStreamingText = "";
		this.activeQuestion = question;

		const mdTheme = getMarkdownTheme();
		this.activeUserComp = new UserMessageComponent(question, mdTheme, this.outputPad);
		this.activeAsstComp = new AssistantMessageComponent(undefined, false, mdTheme, "Thinking...", this.outputPad);
		this.activeAsstComp.setExpanded(this.thinkingExpanded);
		this.activeAsstComp.setStreaming(true);

		const abortController = new AbortController();
		this.activeAbortController = abortController;
		const requestId = ++this.nextRequestId;
		this.currentRequestId = requestId;

		this.tui.requestRender();

		const model = this.model;
		if (!model) {
			this.handleError(requestId, question, "No active model selected for /btw");
			return;
		}

		let authResolution: Awaited<ReturnType<typeof this.modelRegistry.getApiKeyAndHeaders>>;
		try {
			authResolution = await this.modelRegistry.getApiKeyAndHeaders(model);
		} catch (err) {
			if (abortController.signal.aborted || this.currentRequestId !== requestId) return;
			const msg = err instanceof Error ? err.message : String(err);
			this.handleError(requestId, question, `Model credentials failed: ${msg}`);
			return;
		}

		if (abortController.signal.aborted || this.currentRequestId !== requestId) return;

		if (!authResolution.ok) {
			const msg = authResolution.error || `Authentication failed for "${model.provider}"`;
			this.handleError(requestId, question, msg);
			return;
		}

		const provider = this.modelRegistry.getProvider(model.provider);
		if (!provider) {
			this.handleError(requestId, question, `No provider registered for "${model.provider}"`);
			return;
		}

		try {
			const result = await runSideQuestionStream({
				model,
				provider,
				auth: authResolution,
				thinkingLevel: this.thinkingLevel,
				question,
				thread: this.thread,
				signal: abortController.signal,
				onUpdate: (update) => {
					if (abortController.signal.aborted || this.currentRequestId !== requestId) return;
					this.status = update.status;
					if (update.text) {
						this.currentStreamingText = update.text;
					}
					if (update.message) {
						this.activeAsstComp?.updateContent(update.message, true);
					} else if (update.text || update.thinking) {
						const msg = makeAssistantMessage(update.text, model, update.thinking);
						this.activeAsstComp?.updateContent(msg, true);
					}
					this.tui.requestRender();
				},
			});

			if (abortController.signal.aborted || this.currentRequestId !== requestId) return;

			if (result.kind === "done") {
				this.status = "idle";
				this.activeAsstComp?.updateContent(result.message, false);
				this.activeAsstComp?.setStreaming(false);
				if (this.activeUserComp && this.activeAsstComp) {
					// Turn was already pushed into thread.turns inside runSideQuestionStream
					this.committedTurns.push({
						question,
						answer: result.text,
						userComp: this.activeUserComp,
						asstComp: this.activeAsstComp,
					});
				}
			} else if (result.kind === "cancelled") {
				this.status = "cancelled";
				const text = this.currentStreamingText
					? `${this.currentStreamingText}\n\n(Cancelled)`
					: "(Request cancelled)";
				const msg = makeAssistantMessage(text, model);
				this.activeAsstComp?.updateContent(msg, false);
				this.activeAsstComp?.setStreaming(false);
				if (this.activeUserComp && this.activeAsstComp) {
					this.commitTurn(question, text, msg, this.activeUserComp, this.activeAsstComp);
				}
			} else if (result.kind === "error") {
				this.status = "error";
				const text = `Error: ${result.error}`;
				const msg = makeAssistantMessage(text, model);
				this.activeAsstComp?.updateContent(msg, false);
				this.activeAsstComp?.setStreaming(false);
				if (this.activeUserComp && this.activeAsstComp) {
					this.commitTurn(question, text, msg, this.activeUserComp, this.activeAsstComp);
				}
			}
		} catch (err) {
			if (abortController.signal.aborted || this.currentRequestId !== requestId) return;
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.handleError(requestId, question, errorMsg);
		} finally {
			if (this.currentRequestId === requestId) {
				this.isBusy = false;
				this.activeAbortController = undefined;
				this.activeUserComp = undefined;
				this.activeAsstComp = undefined;
				this.activeQuestion = undefined;
				this.currentStreamingText = "";
				this.tui.requestRender();
				this.processQueue();
			}
		}
	}

	private handleError(requestId: number, question: string, errorMsg: string): void {
		if (this.currentRequestId !== requestId) return;
		this.status = "error";
		const text = `Error: ${errorMsg}`;
		const msg = makeAssistantMessage(text, this.model);
		if (this.activeAsstComp) {
			this.activeAsstComp.updateContent(msg, false);
			this.activeAsstComp.setStreaming(false);
		}
		if (this.activeUserComp && this.activeAsstComp) {
			this.commitTurn(question, text, msg, this.activeUserComp, this.activeAsstComp);
		}
		this.isBusy = false;
		this.activeAbortController = undefined;
		this.activeUserComp = undefined;
		this.activeAsstComp = undefined;
		this.activeQuestion = undefined;
		this.currentStreamingText = "";
		this.tui.requestRender();
		this.processQueue();
	}

	private processQueue(): void {
		if (this.queue.length > 0 && !this.isBusy && !this.disposed) {
			const next = this.queue.shift()!;
			void this.executeQuestion(next);
		}
	}

	private formatHint(action: Keybinding, label: string): string {
		const keys = this.keybindings.getKeys(action);
		const keyStr = keys.length > 0 ? formatKeyText(keys.join("/")) : "";
		if (!keyStr) return "";
		return this.theme.fg("dim", keyStr) + this.theme.fg("muted", ` ${label}`);
	}

	private buildFooter(width: number, compactOnly = false): string {
		const cancelHint = this.formatHint("app.btw.cancel", "cancel");
		const closeHint = this.formatHint("app.btw.close", "return to main");
		const submitHint = this.formatHint("tui.input.submit", "submit");
		const newlineHint = this.formatHint("tui.input.newLine", "newline");
		const scrollHint = `${this.theme.fg("dim", "PageUp/Dn")} ${this.theme.fg("muted", "scroll")}`;

		let footerContent = "";
		if (compactOnly || width < 55) {
			footerContent = [cancelHint, closeHint].filter(Boolean).join(this.theme.fg("muted", " · "));
		} else if (width >= 105) {
			footerContent = [submitHint, newlineHint, cancelHint, closeHint, scrollHint]
				.filter(Boolean)
				.join(this.theme.fg("muted", " · "));
		} else if (width >= 65) {
			footerContent = [submitHint, cancelHint, closeHint].filter(Boolean).join(this.theme.fg("muted", " · "));
		} else {
			footerContent = [cancelHint, closeHint].filter(Boolean).join(this.theme.fg("muted", " · "));
		}

		return ` ${footerContent}`;
	}

	private formatTopBorder(baseBorder: string, notice: string, width: number): string {
		if (!notice || width < visibleWidth(notice) + 6) {
			return truncateToWidth(baseBorder, width);
		}
		const leftLen = 4;
		const rightLen = Math.max(0, width - leftLen - visibleWidth(notice));
		return truncateToWidth(
			`${this.theme.fg("border", "─".repeat(leftLen))}${notice}${this.theme.fg("border", "─".repeat(rightLen))}`,
			width,
		);
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const terminalRows = Math.max(1, this.tui.terminal?.rows ?? 24);

		// 1. Handle tiny terminals (1 to 3 rows) where borders/headers cannot fit
		if (terminalRows <= 3) {
			this.editor.setMaxVisibleLines(1);
			const rawEditorLines = this.editor.render(width);
			const contentLines = rawEditorLines.length > 2 ? rawEditorLines.slice(1, -1) : rawEditorLines.slice(1);
			let cursorLineIdx = contentLines.findIndex((line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"));
			if (cursorLineIdx === -1) cursorLineIdx = 0;
			const cursorLine = truncateToWidth(contentLines[cursorLineIdx] ?? "", width);

			if (terminalRows === 1) {
				return [cursorLine];
			}
			if (terminalRows === 2) {
				return [cursorLine, truncateToWidth(this.buildFooter(width, true), width)];
			}
			// terminalRows === 3
			const allTranscriptLines = this.buildAllTranscriptLines(width);
			const transcriptLine = [...allTranscriptLines].reverse().find((l) => l.trim().length > 0) ?? "";
			return [
				truncateToWidth(transcriptLine, width),
				cursorLine,
				truncateToWidth(this.buildFooter(width, true), width),
			];
		}

		// 2. Layout calculation for terminalRows >= 4
		const showHeader = terminalRows >= 5;
		const headerRows = showHeader ? 1 : 0;
		const footerRows = 1;

		// Editor border configuration:
		// 4-5 rows: topBorder + 1 content line (no bottomBorder)
		// >= 6 rows: topBorder + content lines + bottomBorder
		const hasBottomBorder = terminalRows >= 6;
		const editorBorderRows = 1 + (hasBottomBorder ? 1 : 0);

		const availableForTranscriptAndEditor = terminalRows - headerRows - footerRows - editorBorderRows;
		const availableForEditorContent = Math.max(1, availableForTranscriptAndEditor - 1);
		const maxEditorContent = Math.max(
			1,
			Math.min(availableForEditorContent, Math.max(1, Math.floor(availableForTranscriptAndEditor * 0.35))),
		);

		this.editor.setMaxVisibleLines(maxEditorContent);

		// Render Editor and extract content lines
		const rawEditorLines = this.editor.render(width);
		const topBorder = rawEditorLines[0] ?? "";
		const bottomBorder = rawEditorLines.length > 1 ? rawEditorLines[rawEditorLines.length - 1] : "";
		const contentLines = rawEditorLines.length > 2 ? rawEditorLines.slice(1, -1) : rawEditorLines.slice(1);

		let cursorLineIdx = contentLines.findIndex((line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"));
		if (cursorLineIdx === -1) cursorLineIdx = 0;

		const visibleCount = Math.max(1, Math.min(contentLines.length, maxEditorContent));
		let start = 0;
		if (cursorLineIdx < start) {
			start = cursorLineIdx;
		} else if (cursorLineIdx >= start + visibleCount) {
			start = cursorLineIdx - visibleCount + 1;
		}
		start = Math.max(0, Math.min(start, contentLines.length - visibleCount));
		const visibleContentLines = contentLines.slice(start, start + visibleCount);

		const queueNotice = this.queue.length > 0 ? ` ${this.theme.fg("accent", `(${this.queue.length} queued)`)} ` : "";
		const styledTopBorder = this.formatTopBorder(topBorder, queueNotice, width);

		const editorLines: string[] = [];
		editorLines.push(styledTopBorder);
		for (const line of visibleContentLines) {
			editorLines.push(truncateToWidth(line, width));
		}
		if (hasBottomBorder) {
			editorLines.push(truncateToWidth(bottomBorder, width));
		}

		const transcriptHeight = Math.max(1, terminalRows - headerRows - footerRows - editorLines.length);
		this.lastTranscriptHeight = transcriptHeight;

		const lines: string[] = [];

		// Header (1 line if terminalRows >= 5)
		if (showHeader) {
			const prefix = "── ";
			const title = "btw";
			const titleStyled = this.theme.fg("accent", this.theme.bold(title));
			const subTitle = width >= 60 ? this.theme.fg("dim", " ─ side conversation") : "";
			const modelText = this.model && width >= 70 ? this.theme.fg("muted", ` · ${this.model.id}`) : "";

			const leftSide = `${this.theme.fg("border", prefix)}${titleStyled}${subTitle}${modelText}`;
			const leftWidth =
				visibleWidth(prefix) + visibleWidth(title) + visibleWidth(subTitle) + visibleWidth(modelText);

			const badges: string[] = [];
			if (this.queue.length > 0) {
				badges.push(this.theme.fg("accent", `[queued: ${this.queue.length}]`));
			}
			if (this.status === "thinking") {
				badges.push(this.theme.fg("dim", "[thinking...]"));
			} else if (this.status === "streaming") {
				badges.push(this.theme.fg("muted", "[streaming...]"));
			} else if (this.status === "cancelled") {
				badges.push(this.theme.fg("warning", "[cancelled]"));
			} else if (this.status === "error") {
				badges.push(this.theme.fg("error", "[error]"));
			}

			const badgeStr = badges.join(" ");
			const badgeWidth = visibleWidth(badgeStr);
			const rightPart = badgeWidth > 0 ? ` ${badgeStr} ${this.theme.fg("border", "─")}` : "";
			const rightWidth = badgeWidth > 0 ? badgeWidth + 3 : 0;

			const fillWidth = Math.max(0, width - leftWidth - rightWidth - 1);
			const headerLine = `${leftSide} ${this.theme.fg("border", "─".repeat(fillWidth))}${rightPart}`;
			lines.push(truncateToWidth(headerLine, width));
		}

		// Transcript
		const allTranscriptLines = this.buildAllTranscriptLines(width);
		const totalTranscriptLines = allTranscriptLines.length;
		const maxScroll = Math.max(0, totalTranscriptLines - transcriptHeight);
		if (this.autoScroll) {
			this.scrollOffset = maxScroll;
		} else {
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		}

		const visibleTranscript = allTranscriptLines.slice(this.scrollOffset, this.scrollOffset + transcriptHeight);

		for (const line of visibleTranscript) {
			lines.push(line);
		}
		const padCount = transcriptHeight - visibleTranscript.length;
		for (let i = 0; i < padCount; i++) {
			lines.push("");
		}

		// Editor lines (top border, content lines with cursor, bottom border)
		for (const el of editorLines) {
			lines.push(el);
		}

		// Footer line
		const footerLine = this.buildFooter(width, terminalRows < 6);
		lines.push(truncateToWidth(footerLine, width));

		return lines.slice(0, terminalRows);
	}

	private buildAllTranscriptLines(width: number): string[] {
		const allTranscriptLines: string[] = [];

		if (this.committedTurns.length === 0 && !this.activeUserComp) {
			allTranscriptLines.push("");
			allTranscriptLines.push(
				truncateToWidth(this.theme.bold(this.theme.fg("accent", "  Side Conversation")), width),
			);
			allTranscriptLines.push(
				truncateToWidth(
					this.theme.fg("muted", "  Ask questions with active context without modifying main history."),
					width,
				),
			);
			allTranscriptLines.push("");
		} else {
			for (const turn of this.committedTurns) {
				allTranscriptLines.push("");
				const uLines = turn.userComp.render(width);
				for (const ul of uLines) allTranscriptLines.push(ul);

				allTranscriptLines.push("");
				const aLines = turn.asstComp.render(width);
				for (const al of aLines) allTranscriptLines.push(al);
			}

			if (this.activeUserComp) {
				allTranscriptLines.push("");
				const uLines = this.activeUserComp.render(width);
				for (const ul of uLines) allTranscriptLines.push(ul);

				if (this.activeAsstComp) {
					allTranscriptLines.push("");
					this.activeAsstComp.invalidate();
					const aLines = this.activeAsstComp.render(width);
					for (const al of aLines) allTranscriptLines.push(al);
				}
			}
		}

		return allTranscriptLines;
	}
}
