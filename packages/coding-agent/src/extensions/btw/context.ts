/**
 * Context extraction and compaction for the /btw side conversation.
 *
 * Extracts a compacted snapshot of the main conversation branch to give the
 * side model sufficient background without inflating prompt token counts.
 */

import { bashExecutionToText } from "../../core/messages.ts";
import type { SessionEntry } from "../../core/session-manager.ts";

export const MAX_CONTEXT_CHARS = 40_000;
export const MAX_TOOL_RESULT_CHARS = 800;

interface MessageContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	result?: unknown;
}

function formatJsonCompact(value: unknown): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function extractTextLines(content: unknown): string[] {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed ? [trimmed] : [];
	}
	if (!Array.isArray(content)) return [];

	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as MessageContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			const trimmed = block.text.trim();
			if (trimmed) lines.push(trimmed);
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			const args = formatJsonCompact(block.arguments);
			lines.push(`[Tool call: ${block.name}(${args})]`);
		}
	}
	return lines;
}

function extractToolResultText(content: unknown, rawResult?: unknown): string {
	const lines: string[] = [];
	if (Array.isArray(content)) {
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const block = part as MessageContentBlock;
			if (block.type === "text" && typeof block.text === "string") {
				const trimmed = block.text.trim();
				if (trimmed) lines.push(trimmed);
			}
		}
	}
	let resultText = lines.join("\n").trim();
	if (!resultText && rawResult !== undefined) {
		resultText = formatJsonCompact(rawResult).trim();
	}
	if (resultText.length > MAX_TOOL_RESULT_CHARS) {
		resultText = `${resultText.slice(0, MAX_TOOL_RESULT_CHARS)}... [truncated]`;
	}
	return resultText;
}

/**
 * Builds a compacted string snapshot of the main conversation branch.
 *
 * @param entries - Active branch entries (typically from `buildContextEntries`)
 * @returns Plaintext conversation summary snapshot
 */
export function buildConversationContext(entries: readonly SessionEntry[]): string {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type === "compaction") {
			const summary = entry.summary.trim();
			if (summary) {
				sections.push(`[Compaction summary: ${summary}]`);
			}
			continue;
		}

		if (entry.type === "branch_summary") {
			const summary = entry.summary.trim();
			if (summary) {
				sections.push(`[Branch summary: ${summary}]`);
			}
			continue;
		}

		if (entry.type === "custom_message") {
			const lines = extractTextLines(entry.content);
			if (lines.length > 0) {
				sections.push(`[System note: ${lines.join("\n")}]`);
			}
			continue;
		}

		if (entry.type === "message") {
			const msg = entry.message;
			if (!msg || typeof msg !== "object") continue;

			if (msg.role === "user") {
				const lines = extractTextLines(msg.content);
				if (lines.length > 0) {
					sections.push(`User: ${lines.join("\n")}`);
				}
			} else if (msg.role === "assistant") {
				const lines = extractTextLines(msg.content);
				if (lines.length > 0) {
					sections.push(`Assistant: ${lines.join("\n")}`);
				}
			} else if (msg.role === "toolResult") {
				const toolName = "toolName" in msg && typeof msg.toolName === "string" ? msg.toolName : "tool";
				const rawResult = "result" in msg ? msg.result : undefined;
				const resultText = extractToolResultText(msg.content, rawResult);
				if (resultText) {
					sections.push(`[Tool result from ${toolName}: ${resultText}]`);
				}
			} else if (msg.role === "bashExecution") {
				if ("excludeFromContext" in msg && msg.excludeFromContext) {
					continue;
				}
				const text = bashExecutionToText(msg).trim();
				if (text) {
					sections.push(`User: ${text}`);
				}
			}
		}
	}

	const joined = sections.join("\n\n").trim();
	if (!joined) return "";

	if (joined.length <= MAX_CONTEXT_CHARS) {
		return joined;
	}

	return `[Earlier context omitted; showing recent conversation history.]\n\n${joined.slice(-MAX_CONTEXT_CHARS)}`;
}
