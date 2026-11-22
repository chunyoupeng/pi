import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { convertToLlm } from "../../core/messages.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionHeader,
	SessionManager,
} from "../../core/session-manager.ts";
import { createTool, type ToolName } from "../../core/tools/index.ts";
import {
	addUsage,
	COORDINATOR_NAME,
	createEmptyUsage,
	DEFAULT_MAX_TURNS_PER_WAKEUP,
	type SwarmMemberUsage,
	type SwarmStopReason,
	type SwarmTranscriptItem,
	type SwarmWorkerIdleInfo,
	type SwarmWorkspaceMode,
} from "./types.ts";

const WORKER_CODING_TOOLS: readonly ToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const MAX_TRANSCRIPT_ITEMS = 80;

export interface SwarmForkSource {
	sessionFile?: string;
	entries?: readonly FileEntry[];
}

export interface SwarmWorkerHandle {
	readonly name: string;
	readonly sessionFile: string | undefined;
	isRunning(): boolean;
	deliver(text: string, options?: { steer?: boolean }): Promise<void>;
	setModel(model: Model<Api>, thinkingLevel?: ThinkingLevel): void;
	abort(): void;
	dispose(): void;
	getTranscript(): readonly SwarmTranscriptItem[];
	getUsage(): SwarmMemberUsage;
	getCurrentActivity(): string | undefined;
}

export interface SwarmWorkerFactoryInput {
	name: string;
	addedBy: string;
	cwd: string;
	workspace: SwarmWorkspaceMode;
	gitBranch?: string;
	brief: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	modelRegistry: ModelRegistry;
	sessionsDir: string;
	existingSessionFile?: string;
	forkSource?: SwarmForkSource;
	initialUsage?: SwarmMemberUsage;
	swarmTools: AgentTool[];
	maxTurnsPerWakeup?: number;
	onActivityChange: (activity: string | undefined) => void;
	onUsageChange: (usage: SwarmMemberUsage) => void;
	onIdle: (info: SwarmWorkerIdleInfo) => void;
}

export type SwarmWorkerFactory = (input: SwarmWorkerFactoryInput) => Promise<SwarmWorkerHandle> | SwarmWorkerHandle;

function buildWorkerSystemPrompt(input: {
	name: string;
	addedBy: string;
	cwd: string;
	workspace: SwarmWorkspaceMode;
	gitBranch?: string;
}): string {
	const lines = [
		`You are swarm worker "@${input.name}" in a multi-agent Pi swarm.`,
		`You were added by @${input.addedBy}.`,
		`Working directory: ${input.cwd}`,
		`Workspace mode: ${input.workspace}${input.gitBranch ? ` (git branch: ${input.gitBranch})` : ""}`,
		"",
		"How the swarm message board works:",
		"- All swarm members coordinate on a shared public message board using @mentions.",
		"- Use `board_post` to post progress, handoffs, questions, or blockers to the board. Tag recipients with @name (for example `@coordinator`, `@" +
			input.addedBy +
			"`, or `@all`).",
		"- Use `board_read` if you need to review earlier board history.",
		"- Use `swarm` to check `status`, list `models`, add helpers (`add`), switch your or your helpers' `model`, or `kill` helpers you added.",
		"",
		"Working rules:",
		"- When you finish your assigned task or hit a blocker, post a concise summary with `board_post` mentioning @" +
			input.addedBy +
			(input.addedBy !== COORDINATOR_NAME ? ` (and @${COORDINATOR_NAME} when relevant)` : "") +
			", then end your turn so you return to the idle `waiting` state.",
		"- Never post empty acknowledgements, thank-yous, or 'got it' replies.",
		"- Verify your edits by running relevant checks/tests before declaring completion.",
	];
	if (input.workspace === "share" || input.workspace === "branch") {
		lines.push(
			`- Because you work in an isolated ${input.workspace} workspace on branch '${input.gitBranch ?? "HEAD"}', commit your verified changes on that branch and include the branch name and verification output in your board update so @${COORDINATOR_NAME} can review and land your work before killing this worker.`,
		);
	} else {
		lines.push(
			"- You share the host working directory (`inherit`). Only read/verify or edit files explicitly assigned to you so you do not collide with other workers.",
		);
	}
	return lines.join("\n");
}

function summarizeToolActivity(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return toolName;
	const rec = args as Record<string, unknown>;
	if (toolName === "bash" && typeof rec.command === "string") {
		const cmd = rec.command.replace(/\s+/g, " ").trim();
		return `bash: ${cmd.length > 48 ? `${cmd.slice(0, 45)}...` : cmd}`;
	}
	if ((toolName === "read" || toolName === "edit" || toolName === "write") && typeof rec.path === "string") {
		return `${toolName}: ${rec.path}`;
	}
	if (toolName === "board_post") return "posting to board";
	if (toolName === "swarm" && typeof rec.action === "string") return `swarm ${rec.action}`;
	return toolName;
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Read the tail of a persisted worker session JSONL file for `swarm inspect` when a worker is not loaded in memory. */
export function readSessionTranscriptTail(sessionFile: string | undefined, limit = 20): SwarmTranscriptItem[] {
	if (!sessionFile || !existsSync(sessionFile)) return [];
	try {
		const raw = readFileSync(sessionFile, "utf-8");
		const items: SwarmTranscriptItem[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
			const msg = entry.message as Record<string, unknown>;
			const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
			const role = msg.role;
			if (role === "user") {
				const content = msg.content;
				const text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.filter(
										(p): p is { type: string; text: string } =>
											typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text",
									)
									.map((p) => p.text)
									.join("\n")
							: "";
				const compact = text.trim();
				if (compact) {
					items.push({
						timestamp: ts,
						kind: "prompt",
						summary: compact.length > 240 ? `${compact.slice(0, 237)}...` : compact,
					});
				}
			} else if (role === "assistant") {
				const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
				const texts: string[] = [];
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
						texts.push(part.text.trim());
					} else if (part.type === "toolCall" && typeof part.name === "string") {
						items.push({
							timestamp: ts,
							kind: "tool",
							summary: summarizeToolActivity(part.name, part.arguments),
						});
					}
				}
				const joined = texts.join("\n").trim();
				if (joined) {
					items.push({
						timestamp: ts,
						kind: "text",
						summary: joined.length > 400 ? `${joined.slice(0, 397)}...` : joined,
					});
				}
				if (msg.stopReason === "error" && typeof msg.errorMessage === "string") {
					items.push({ timestamp: ts, kind: "error", summary: msg.errorMessage });
				}
			}
		}
		return limit > 0 && items.length > limit ? items.slice(-limit) : items;
	} catch {
		return [];
	}
}

function createSeededSessionFile(sessionsDir: string, cwd: string, entries: readonly FileEntry[]): SessionManager {
	mkdirSync(sessionsDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const id = `swarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const sessionFile = join(sessionsDir, `${fileTimestamp}_${id}.jsonl`);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp,
		cwd,
	};
	const fd = openSync(sessionFile, "wx");
	try {
		writeFileSync(fd, `${JSON.stringify(header)}\n`);
		for (const entry of entries) {
			if (entry.type !== "session") {
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			}
		}
	} finally {
		closeSync(fd);
	}
	return SessionManager.open(sessionFile, sessionsDir, cwd);
}

function initWorkerSessionManager(input: SwarmWorkerFactoryInput): SessionManager {
	mkdirSync(input.sessionsDir, { recursive: true });
	if (input.existingSessionFile && existsSync(input.existingSessionFile)) {
		return SessionManager.open(input.existingSessionFile, input.sessionsDir, input.cwd);
	}
	if (input.forkSource?.sessionFile && existsSync(input.forkSource.sessionFile)) {
		return SessionManager.forkFrom(input.forkSource.sessionFile, input.cwd, input.sessionsDir);
	}
	if (input.forkSource?.entries && input.forkSource.entries.length > 0) {
		return createSeededSessionFile(input.sessionsDir, input.cwd, input.forkSource.entries);
	}
	return SessionManager.create(input.cwd, input.sessionsDir);
}

export function createPiSwarmWorker(input: SwarmWorkerFactoryInput): SwarmWorkerHandle {
	const sessionManager = initWorkerSessionManager(input);
	const restored = sessionManager.buildSessionContext();
	const systemPrompt = buildWorkerSystemPrompt({
		name: input.name,
		addedBy: input.addedBy,
		cwd: input.cwd,
		workspace: input.workspace,
		gitBranch: input.gitBranch,
	});

	const tools: AgentTool[] = [
		...WORKER_CODING_TOOLS.map((toolName) => createTool(toolName, input.cwd)),
		...input.swarmTools,
	];

	const restoredMessages: AgentMessage[] = restored.messages.filter((m) => m.role !== "system");
	const maxTurns = input.maxTurnsPerWakeup ?? DEFAULT_MAX_TURNS_PER_WAKEUP;

	let turnsThisWakeup = 0;
	let hitMaxTurns = false;
	let wasAborted = false;
	let lastAssistantText: string | undefined;
	let usage: SwarmMemberUsage = input.initialUsage ? { ...input.initialUsage } : createEmptyUsage();
	let currentActivity: string | undefined;
	let disposed = false;
	let lastRunError: string | undefined;
	const transcript: SwarmTranscriptItem[] = [];

	const pushTranscript = (kind: SwarmTranscriptItem["kind"], summary: string): void => {
		const trimmed = summary.trim();
		if (!trimmed) return;
		transcript.push({ timestamp: Date.now(), kind, summary: trimmed });
		if (transcript.length > MAX_TRANSCRIPT_ITEMS) {
			transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ITEMS);
		}
	};

	const setActivity = (next: string | undefined): void => {
		if (currentActivity === next) return;
		currentActivity = next;
		input.onActivityChange(next);
	};

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			tools,
			messages: restoredMessages,
		},
		convertToLlm,
		sessionId: sessionManager.getSessionId(),
		streamFn: (model, context, streamOptions) => input.modelRegistry.streamSimple(model, context, streamOptions),
		finishTurn: () => {
			if (turnsThisWakeup >= maxTurns) {
				hitMaxTurns = true;
				return { action: "end" };
			}
			return undefined;
		},
	});

	if (restoredMessages.length === 0 || !input.existingSessionFile) {
		if (
			!restored.model ||
			restored.model.provider !== input.model.provider ||
			restored.model.modelId !== input.model.id
		) {
			sessionManager.appendModelChange(input.model.provider, input.model.id);
		}
		if (restoredMessages.length === 0 || restored.thinkingLevel !== input.thinkingLevel) {
			sessionManager.appendThinkingLevelChange(input.thinkingLevel);
		}
	}

	const unsubscribe = agent.subscribe((event) => {
		if (disposed) return;

		switch (event.type) {
			case "turn_start": {
				turnsThisWakeup++;
				setActivity("thinking...");
				break;
			}
			case "tool_execution_start": {
				const summary = summarizeToolActivity(event.toolName, event.args);
				setActivity(summary);
				pushTranscript("tool", summary);
				break;
			}
			case "tool_execution_end": {
				setActivity("thinking...");
				break;
			}
			case "message_end": {
				const msg = event.message;
				if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult") {
					sessionManager.appendMessage(msg);
				}
				if (msg.role === "assistant") {
					const assistant = msg as AssistantMessage;
					const text = extractAssistantText(assistant);
					if (text) {
						lastAssistantText = text.length > 300 ? `${text.slice(0, 297)}...` : text;
						pushTranscript("text", text.length > 400 ? `${text.slice(0, 397)}...` : text);
					}
					if (assistant.stopReason === "error") {
						lastRunError = assistant.errorMessage ?? "Provider request failed";
						pushTranscript("error", lastRunError);
					} else if (assistant.stopReason === "aborted") {
						wasAborted = true;
					}
					usage = addUsage(usage, {
						turns: 1,
						input: assistant.usage?.input ?? 0,
						output: assistant.usage?.output ?? 0,
						cacheRead: assistant.usage?.cacheRead ?? 0,
						cacheWrite: assistant.usage?.cacheWrite ?? 0,
						cost: assistant.usage?.cost?.total ?? 0,
					});
					input.onUsageChange(usage);
				}
				break;
			}
			case "agent_end": {
				setActivity(undefined);
				const error = lastRunError;
				const reason: SwarmStopReason = error
					? "error"
					: wasAborted
						? "aborted"
						: hitMaxTurns
							? "max_turns"
							: "idle";
				const idleInfo: SwarmWorkerIdleInfo = {
					reason,
					turnsUsed: turnsThisWakeup,
					maxTurns,
					lastOutput: lastAssistantText,
					error,
				};
				lastRunError = undefined;
				hitMaxTurns = false;
				wasAborted = false;
				input.onIdle(idleInfo);
				break;
			}
		}
	});

	return {
		name: input.name,
		get sessionFile() {
			return sessionManager.getSessionFile();
		},
		isRunning(): boolean {
			return agent.state.isStreaming || agent.signal !== undefined;
		},
		async deliver(text: string, options?: { steer?: boolean }): Promise<void> {
			if (disposed) return;
			pushTranscript("prompt", text.length > 240 ? `${text.slice(0, 237)}...` : text);
			if (agent.state.isStreaming || agent.signal !== undefined) {
				const msg: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
				if (options?.steer) {
					agent.steer(msg);
				} else {
					agent.followUp(msg);
				}
				return;
			}
			turnsThisWakeup = 0;
			hitMaxTurns = false;
			wasAborted = false;
			lastAssistantText = undefined;
			lastRunError = undefined;
			setActivity("starting...");
			void agent.prompt(text).catch((err) => {
				if (disposed) return;
				const msg = err instanceof Error ? err.message : String(err);
				pushTranscript("error", msg);
				setActivity(undefined);
				input.onIdle({
					reason: "error",
					turnsUsed: turnsThisWakeup,
					maxTurns,
					lastOutput: lastAssistantText,
					error: msg,
				});
			});
		},
		setModel(model: Model<Api>, thinkingLevel?: ThinkingLevel): void {
			agent.state.model = model;
			if (thinkingLevel !== undefined) {
				agent.state.thinkingLevel = thinkingLevel;
				sessionManager.appendThinkingLevelChange(thinkingLevel);
			}
			sessionManager.appendModelChange(model.provider, model.id);
		},
		abort(): void {
			wasAborted = true;
			agent.clearAllQueues();
			agent.abort();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			agent.clearAllQueues();
			agent.abort();
			unsubscribe();
			setActivity(undefined);
		},
		getTranscript(): readonly SwarmTranscriptItem[] {
			return transcript;
		},
		getUsage(): SwarmMemberUsage {
			return { ...usage };
		},
		getCurrentActivity(): string | undefined {
			return currentActivity;
		},
	};
}
