/**
 * Built-in automatic session titles.
 *
 * After four completed user/reply rounds, unnamed sessions get a short title
 * from a separate, tool-free request to the current model. Assistant replies
 * that end in tool calls do not complete a round. Any session_info entry,
 * including one that clears a name, disables automatic naming for the session.
 */

import { type AssistantMessage, normalizeContext, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

export const TITLE_ROUNDS = 4;
const MAX_ROUND_TEXT_CHARS = 2000;
const MAX_TITLE_CHARS = 80;

const TITLE_SYSTEM_PROMPT = `You write short titles for coding-agent sessions.

Reply with only the title: 3 to 8 words, no quotes, no trailing punctuation, in the language the user writes in.`;

export interface Round {
	user: string;
	reply: string;
}

function messageText(message: UserMessage | AssistantMessage): string {
	if (typeof message.content === "string") return message.content.trim();
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export function collectRounds(ctx: Pick<ExtensionContext, "sessionManager">): Round[] {
	const rounds: Round[] = [];
	let user: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			user = messageText(message);
		} else if (message.role === "assistant" && user !== undefined && message.stopReason === "stop") {
			rounds.push({ user, reply: messageText(message) });
			user = undefined;
		}
	}
	return rounds;
}

function clip(text: string): string {
	return text.length > MAX_ROUND_TEXT_CHARS ? `${text.slice(0, MAX_ROUND_TEXT_CHARS)}...` : text;
}

export function buildTitlePrompt(rounds: Round[]): string {
	const body = rounds
		.map(
			(round, i) =>
				`<round index="${i + 1}">\n<user>\n${clip(round.user)}\n</user>\n<assistant>\n${clip(round.reply)}\n</assistant>\n</round>`,
		)
		.join("\n");
	return `Write a title for this conversation.\n\n${body}`;
}

export function cleanTitle(text: string): string | undefined {
	const line = text.split("\n").find((l) => l.trim().length > 0);
	if (!line) return undefined;
	const title = line
		.trim()
		.replace(/^(title:\s*)/i, "")
		.replace(/^["'`“”]+|["'`“”.。]+$/g, "")
		.trim();
	if (!title) return undefined;
	return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS).trim() : title;
}

async function generateTitle(ctx: ExtensionContext, rounds: Round[]): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;
	const effectiveModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
	const context = normalizeContext({
		systemPrompt: TITLE_SYSTEM_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text: buildTitlePrompt(rounds) }], timestamp: Date.now() }],
	});
	const response = await provider
		.streamSimple(effectiveModel, context, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env })
		.result();
	if (response.stopReason !== "stop") return undefined;
	return cleanTitle(messageText(response));
}

export default function autoSessionNameExtension(pi: ExtensionAPI): void {
	let pending = false;

	pi.on("agent_end", (_event, ctx) => {
		if (pending) return;
		if (ctx.sessionManager.getEntries().some((entry) => entry.type === "session_info")) return;
		const rounds = collectRounds(ctx);
		if (rounds.length < TITLE_ROUNDS) return;
		const sessionId = ctx.sessionManager.getSessionId();

		pending = true;
		void generateTitle(ctx, rounds.slice(0, TITLE_ROUNDS))
			.then((title) => {
				if (!title || ctx.sessionManager.getSessionId() !== sessionId) return;
				if (ctx.sessionManager.getEntries().some((entry) => entry.type === "session_info")) return;
				pi.setSessionName(title);
			})
			.catch(() => {
				// Retried after a later reply
			})
			.finally(() => {
				pending = false;
			});
	});
}
