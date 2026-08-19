/**
 * TPS Extension
 *
 * Notifies tokens-per-second at the end of each turn.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Random show-off words for the done notification, mirroring DEFAULT_WORKING_MESSAGES. */
const COOKED_WORDS = [
	"出锅", "大成", "圆满",
	"Served", "Forged", "Manifest",
	"Accompli", "Compiuto", "Servido",
	"Confectum", "Telos", "Siddham",
	"Kansei", "Zenith", "Omega",
] as const;

function pickCookedWord(random: () => number = Math.random): string {
	return COOKED_WORDS[Math.floor(random() * COOKED_WORDS.length)] ?? COOKED_WORDS[0];
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

export default function (pi: ExtensionAPI) {
	let agentStartMs: number | null = null;

	pi.on("agent_start", () => {
		agentStartMs = Date.now();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = Date.now() - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		let output = 0;
		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			output += message.usage.output || 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;
		ctx.ui.notify(
			`✶ ${pickCookedWord()} ${elapsedSeconds.toFixed(1)}s · ${tokensPerSecond.toFixed(1)} tok/s`,
			"info",
		);
	});
}
