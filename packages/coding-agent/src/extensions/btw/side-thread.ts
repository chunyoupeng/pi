/**
 * Isolated side conversation data structures and stream runner for /btw.
 *
 * Runs an independent, tool-free LLM stream outside the main agent loop.
 * State is isolated to this extension and not persisted to session entries.
 */

import {
	type Api,
	type AssistantMessage,
	type Context,
	clampThinkingLevel,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type Provider,
	type SimpleStreamOptions,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { ResolvedRequestAuth } from "../../core/model-registry.ts";

export const SIDE_SYSTEM_PROMPT = `You answer quick side questions for a coding-agent user.

Use the provided conversation context only as background. Answer the user's side question directly and concisely. Do not claim to have changed files, run tools, or affected the main task. If the context is insufficient, say what is unknown and give the best next step.`;

export type StreamStatus = "thinking" | "streaming" | "done" | "cancelled" | "error";

export interface StreamUpdate {
	status: StreamStatus;
	text: string;
	error?: string;
	thinking?: string;
	message?: AssistantMessage;
}

export interface SideThreadTurn {
	question: string;
	answer: string;
	response?: AssistantMessage;
}

export interface SideThread {
	conversationContext: string;
	turns: SideThreadTurn[];
}

export type StreamResult =
	| { kind: "done"; text: string; message: AssistantMessage }
	| { kind: "cancelled" }
	| { kind: "error"; error: string };

export interface RunSideQuestionOptions {
	model: Model<Api>;
	provider: Provider;
	auth: Extract<ResolvedRequestAuth, { ok: true }>;
	thinkingLevel?: string;
	question: string;
	thread: SideThread;
	signal: AbortSignal;
	onUpdate?: (update: StreamUpdate) => void;
}

export function createSideThread(conversationContext: string): SideThread {
	return {
		conversationContext,
		turns: [],
	};
}

export function buildFirstQuestionPrompt(question: string, context: string): string {
	return [
		"Answer this side question without modifying the main conversation.",
		"",
		"<side_question>",
		question,
		"</side_question>",
		"",
		"<conversation_context>",
		context || "No prior conversation context was available.",
		"</conversation_context>",
	].join("\n");
}

export function buildFollowUpPrompt(question: string): string {
	return ["Continue the same side conversation.", "", "<side_question>", question, "</side_question>"].join("\n");
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export function createFallbackAssistantMessage(text: string, model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
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
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function extractAssistantText(message: AssistantMessage): string {
	if (!message.content || !Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * Builds the isolated message history for the side conversation.
 * First turn contains system prompt + background context snapshot.
 * Subsequent turns contain user questions and assistant answers.
 */
export function buildSideThreadMessages(thread: SideThread, newQuestion: string, model: Model<Api>): Message[] {
	const messages: Message[] = [];

	if (thread.turns.length === 0) {
		messages.push(createUserMessage(buildFirstQuestionPrompt(newQuestion, thread.conversationContext)));
		return messages;
	}

	const firstTurn = thread.turns[0];
	messages.push(
		createUserMessage(buildFirstQuestionPrompt(firstTurn.question, thread.conversationContext)),
		firstTurn.response ?? createFallbackAssistantMessage(firstTurn.answer, model),
	);

	for (let i = 1; i < thread.turns.length; i++) {
		const turn = thread.turns[i];
		messages.push(
			createUserMessage(buildFollowUpPrompt(turn.question)),
			turn.response ?? createFallbackAssistantMessage(turn.answer, model),
		);
	}

	messages.push(createUserMessage(buildFollowUpPrompt(newQuestion)));
	return messages;
}

/**
 * Runs a side question stream using the provider's `streamSimple` method.
 * Does not use tools and does not write to the main conversation context.
 */
export async function runSideQuestionStream({
	model,
	provider,
	auth,
	thinkingLevel,
	question,
	thread,
	signal,
	onUpdate,
}: RunSideQuestionOptions): Promise<StreamResult> {
	if (signal.aborted) {
		onUpdate?.({ status: "cancelled", text: "" });
		return { kind: "cancelled" };
	}

	const effectiveModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
	const messages = buildSideThreadMessages(thread, question, effectiveModel);
	const context: Context = {
		systemPrompt: SIDE_SYSTEM_PROMPT,
		messages,
	};

	const streamOptions: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal,
	};

	if (thinkingLevel && thinkingLevel !== "off") {
		const clamped = clampThinkingLevel(effectiveModel, thinkingLevel as ModelThinkingLevel);
		if (clamped !== "off") {
			streamOptions.reasoning = clamped;
		}
	}

	let accumulatedText = "";
	let accumulatedThinking = "";
	let currentStatus: StreamStatus = "thinking";
	onUpdate?.({ status: currentStatus, text: "" });

	try {
		const stream = provider.streamSimple(effectiveModel, context, streamOptions);

		for await (const event of stream) {
			if (signal.aborted) {
				currentStatus = "cancelled";
				onUpdate?.({ status: "cancelled", text: accumulatedText });
				return { kind: "cancelled" };
			}

			if (event.type === "thinking_delta") {
				currentStatus = "thinking";
				accumulatedThinking += event.delta;
				onUpdate?.({
					status: currentStatus,
					text: accumulatedText,
					thinking: accumulatedThinking,
					message: "partial" in event && event.partial ? event.partial : undefined,
				});
			} else if (event.type === "text_delta") {
				currentStatus = "streaming";
				accumulatedText += event.delta;
				onUpdate?.({
					status: currentStatus,
					text: accumulatedText,
					thinking: accumulatedThinking,
					message: "partial" in event && event.partial ? event.partial : undefined,
				});
			} else if (event.type === "done") {
				currentStatus = "done";
				const finalText = extractAssistantText(event.message) || accumulatedText;
				thread.turns.push({
					question,
					answer: finalText,
					response: event.message,
				});
				onUpdate?.({ status: "done", text: finalText, message: event.message });
				return { kind: "done", text: finalText, message: event.message };
			} else if (event.type === "error") {
				if (signal.aborted || event.reason === "aborted") {
					currentStatus = "cancelled";
					onUpdate?.({ status: "cancelled", text: accumulatedText });
					return { kind: "cancelled" };
				}
				const errorMsg = event.error.errorMessage ?? "Side question stream error";
				currentStatus = "error";
				onUpdate?.({ status: "error", text: accumulatedText, error: errorMsg });
				return { kind: "error", error: errorMsg };
			}
		}

		if (signal.aborted) {
			onUpdate?.({ status: "cancelled", text: accumulatedText });
			return { kind: "cancelled" };
		}

		const finalMessage = await stream.result();
		const finalText = extractAssistantText(finalMessage) || accumulatedText;
		thread.turns.push({
			question,
			answer: finalText,
			response: finalMessage,
		});
		onUpdate?.({ status: "done", text: finalText, message: finalMessage });
		return { kind: "done", text: finalText, message: finalMessage };
	} catch (err) {
		if (signal.aborted) {
			currentStatus = "cancelled";
			onUpdate?.({ status: "cancelled", text: accumulatedText });
			return { kind: "cancelled" };
		}
		const errorMsg = err instanceof Error ? err.message : String(err);
		currentStatus = "error";
		onUpdate?.({ status: "error", text: accumulatedText, error: errorMsg });
		return { kind: "error", error: errorMsg };
	}
}
