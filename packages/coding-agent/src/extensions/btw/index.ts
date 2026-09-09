/**
 * Built-in fullscreen /btw extension.
 *
 * Runs an independent, tool-free model stream using the current model/auth
 * and a compacted conversation context snapshot from the active branch.
 *
 * Features:
 * - Enters a fullscreen overlay UI matching the main window appearance.
 * - Continuous, isolated multi-turn side conversation inside the same view.
 * - Multiline input editor at bottom.
 * - Configurable keybindings: Ctrl+C cancels active side request, Esc returns to main.
 * - Ongoing side requests are cancelled on exit to prevent hidden costs.
 * - Reopening /btw retains prior side conversation history.
 * - Side questions and answers are never injected into the main LLM context or session.
 * - Does not interrupt active main runs.
 * - `/btw [question]`: opens fullscreen UI, optionally submitting initial question.
 * - `/btw cancel`: cancels in-progress side stream.
 * - `/btw clear`: clears side conversation state.
 * - Cleans up on shutdown, reload, and tree navigation.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { buildConversationContext } from "./context.ts";
import {
	buildFirstQuestionPrompt,
	buildFollowUpPrompt,
	buildSideThreadMessages,
	createFallbackAssistantMessage,
	createSideThread,
	extractAssistantText,
	runSideQuestionStream,
	SIDE_SYSTEM_PROMPT,
	type SideThread,
	type SideThreadTurn,
	type StreamResult,
	type StreamStatus,
	type StreamUpdate,
} from "./side-thread.ts";
import { BtwView } from "./view.ts";

export { buildConversationContext, MAX_CONTEXT_CHARS } from "./context.ts";
export {
	buildFirstQuestionPrompt,
	buildFollowUpPrompt,
	buildSideThreadMessages,
	createFallbackAssistantMessage,
	createSideThread,
	extractAssistantText,
	runSideQuestionStream,
	SIDE_SYSTEM_PROMPT,
	type SideThread,
	type SideThreadTurn,
	type StreamResult,
	type StreamStatus,
	type StreamUpdate,
};
export { BtwView, type BtwViewOptions } from "./view.ts";

function notifySafely(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error"): void {
	if (!ctx) return;
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Context might be disposed or replaced
	}
}

export default function btwExtension(pi: ExtensionAPI): void {
	let currentThread: SideThread | undefined;
	let activeView: BtwView | undefined;

	const clearSideState = (_ctx?: ExtensionContext): void => {
		if (activeView) {
			activeView.dispose();
			activeView = undefined;
		}
		currentThread = undefined;
	};

	// Register /btw command
	pi.registerCommand("btw", {
		description: "Ask a quick side question without adding it to the main conversation",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				notifySafely(ctx, "/btw requires interactive TUI mode", "error");
				return;
			}

			const trimmed = args.trim();
			const lower = trimmed.toLowerCase();

			if (lower === "cancel") {
				if (activeView) {
					activeView.dispose();
					activeView = undefined;
					notifySafely(ctx, "Cancelled /btw side question", "info");
				} else {
					notifySafely(ctx, "No active /btw question to cancel", "info");
				}
				return;
			}

			if (lower === "clear") {
				clearSideState(ctx);
				notifySafely(ctx, "Cleared /btw side conversation", "info");
				return;
			}

			if (lower === "help" || trimmed === "--help" || trimmed === "-h") {
				notifySafely(
					ctx,
					"Usage: /btw [question] (open side conversation) | /btw cancel (cancel stream) | /btw clear (clear conversation)",
					"info",
				);
				return;
			}

			// Initialize side thread if not yet created for this session
			if (!currentThread) {
				const entries = ctx.sessionManager.buildContextEntries();
				const snapshot = buildConversationContext(entries);
				currentThread = createSideThread(snapshot);
			}

			// /btw show opens the fullscreen viewer for existing history without submitting a new question
			const initialQuestion = lower === "show" ? undefined : trimmed ? trimmed : undefined;

			await ctx.ui.custom<void>(
				(tui, themeInstance, keybindings, done) => {
					const view = new BtwView({
						tui,
						theme: themeInstance,
						keybindings,
						thread: currentThread!,
						model: ctx.model,
						modelRegistry: ctx.modelRegistry,
						thinkingLevel: ctx.thinkingLevel,
						initialQuestion,
						onDone: () => {
							activeView = undefined;
							done();
						},
					});
					activeView = view;
					return view;
				},
				{
					overlay: true,
					overlayOptions: {
						maxHeight: "100%",
						width: "100%",
						anchor: "top-left",
					},
				},
			);
		},
	});

	// Session lifecycle events: cleanup background streams and state
	pi.on("session_shutdown", (_event, ctx) => {
		clearSideState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		clearSideState(ctx);
	});

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") {
			clearSideState(ctx);
		}
	});
}
