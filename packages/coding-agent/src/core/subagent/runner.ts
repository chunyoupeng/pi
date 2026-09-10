import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type AgentToolUpdateCallback,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { allToolNames, createTool, type ToolName, type ToolsOptions } from "../tools/index.ts";
import { generateRandomName, generateSubagentSessionId } from "./names.ts";
import type { SubagentSessionPool } from "./session-pool.ts";
import {
	DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
	MAX_SUBAGENT_TIMEOUT_SECONDS,
	SUBAGENT_SUMMARY_TIMEOUT_SECONDS,
	type SubagentExecutionStep,
	type SubagentProfile,
	type SubagentToolDetails,
	type SubagentUsage,
} from "./types.ts";

export interface RunSubagentOptions {
	profile: SubagentProfile;
	task: string;
	cwd: string;
	sessionId?: string;
	resetSession?: boolean;
	timeout?: number;
	sessionPool?: SubagentSessionPool;
	parentModel?: Model<any>;
	parentThinkingLevel?: ThinkingLevel;
	modelRegistry?: ModelRegistry;
	toolsOptions?: ToolsOptions;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<SubagentToolDetails>;
}

export interface RunSubagentResult {
	finalText: string;
	details: SubagentToolDetails;
}

const EMPTY_USAGE: SubagentUsage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function assistantText(messages: readonly AgentMessage[]): string {
	return messages
		.filter((message): message is AssistantMessage => message.role === "assistant")
		.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				: [],
		)
		.join("\n")
		.trim();
}

export async function runSubagent(options: RunSubagentOptions): Promise<RunSubagentResult> {
	if (options.profile.disabled === true) throw new Error(`Subagent '${options.profile.name}' is disabled`);
	if (options.signal?.aborted) throw new Error("Subagent operation aborted");
	const startedAt = Date.now();
	const timeout = options.timeout ?? DEFAULT_SUBAGENT_TIMEOUT_SECONDS;
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_SUBAGENT_TIMEOUT_SECONDS) {
		throw new Error(
			`Invalid subagent timeout: must be greater than 0 and at most ${MAX_SUBAGENT_TIMEOUT_SECONDS} seconds`,
		);
	}
	const name = generateRandomName();
	const sessionId = options.sessionId || generateSubagentSessionId(options.profile.name, name);
	const release = options.sessionPool?.acquire(sessionId);
	try {
		return await executeSubagent({ ...options, sessionId, name, timeout, startedAt });
	} finally {
		release?.();
	}
}

async function executeSubagent(
	options: RunSubagentOptions & { sessionId: string; name: string; timeout: number; startedAt: number },
): Promise<RunSubagentResult> {
	const { profile, task, cwd, sessionId, timeout, startedAt, sessionPool, modelRegistry, signal, onUpdate } = options;
	let targetModel = options.parentModel;
	const targetThinkingLevel = profile.thinkingLevel ?? options.parentThinkingLevel;
	if (profile.modelId && modelRegistry) {
		const slash = profile.modelId.indexOf("/");
		if (slash !== -1) {
			targetModel =
				modelRegistry.find(profile.modelId.slice(0, slash), profile.modelId.slice(slash + 1)) ?? targetModel;
		}
	}
	if (!targetModel) throw new Error(`No model available to run subagent '${profile.name}'`);

	if (options.resetSession) sessionPool?.delete(sessionId);
	const existingSession = sessionPool?.get(sessionId);
	const isResumed = existingSession?.agent === profile.name;
	const name = isResumed ? existingSession.name : options.name;
	let subAgent: Agent;
	if (isResumed) {
		subAgent = existingSession.subAgent;
		subAgent.state.model = targetModel;
		if (targetThinkingLevel !== undefined) subAgent.state.thinkingLevel = targetThinkingLevel;
	} else {
		const subagentTools: AgentTool<any>[] = [];
		for (const toolName of profile.tools) {
			if (toolName !== "subagent" && allToolNames.has(toolName as ToolName)) {
				subagentTools.push(createTool(toolName as ToolName, cwd, options.toolsOptions));
			}
		}
		subAgent = new Agent({
			initialState: {
				systemPrompt: profile.systemPrompt,
				model: targetModel,
				thinkingLevel: targetThinkingLevel ?? "off",
				tools: subagentTools,
			},
			streamFn: (model, context, streamOptions) => {
				streamOptions?.signal?.throwIfAborted();
				return streamSimple(model, context, streamOptions);
			},
		});
	}

	const tools = subAgent.state.tools;
	const thinkingLevel = subAgent.state.thinkingLevel;
	const shouldStopAfterTurn = subAgent.shouldStopAfterTurn;
	const messageStart = subAgent.state.messages.length;
	const steps: SubagentExecutionStep[] = [];
	const previousUsage = existingSession?.totalUsage ?? EMPTY_USAGE;
	const baseDetails = {
		agent: profile.name,
		name,
		sessionId,
		isResumed,
		task,
		timeout,
		source: profile.source,
		model: `${targetModel.provider}/${targetModel.id}`,
		thinkingLevel: targetThinkingLevel,
	};
	const saveSession = (usage: SubagentUsage) => {
		sessionPool?.set(sessionId, {
			sessionId,
			name,
			agent: profile.name,
			subAgent,
			createdAt: existingSession?.createdAt ?? startedAt,
			lastUsedAt: Date.now(),
			totalTurns: usage.turns,
			totalUsage: usage,
			historySteps: [...(existingSession?.historySteps ?? []), ...steps],
		});
	};
	let turns = 0;
	let timedOut = false;
	let cancelled = false;
	let summaryStart: number | undefined;
	let summaryFailure: string | undefined;
	const controller = new AbortController();
	const onAbort = () => {
		cancelled = true;
		subAgent.abort();
		controller.abort(new Error("Subagent execution aborted"));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	const update = (text: string) =>
		onUpdate?.({
			content: [{ type: "text", text: `[${profile.name}: ${name}] ${text}` }],
			details: { ...baseDetails, status: timedOut ? "summarizing" : "running", steps: [...steps] },
		});
	const unsubscribe = subAgent.subscribe((event) => {
		if (event.type === "turn_start") turns++;
		if (event.type === "tool_execution_start" && !timedOut) {
			steps.push({ type: "toolCall", name: event.toolName, args: event.args ?? {} });
			update(`Running tool ${event.toolName}...`);
		}
	});

	// The work budget includes authentication. Reserve cancellation/summary time inside ten minutes.
	const workSeconds = Math.min(timeout, MAX_SUBAGENT_TIMEOUT_SECONDS - SUBAGENT_SUMMARY_TIMEOUT_SECONDS);
	const workDeadline = startedAt + workSeconds * 1000;
	const hardDeadline = workDeadline + SUBAGENT_SUMMARY_TIMEOUT_SECONDS * 1000;
	const workTimer = setTimeout(
		() => {
			timedOut = true;
			subAgent.abort();
			try {
				update("Timed out; stopping work and summarizing...");
			} catch (error) {
				controller.abort(error);
			}
		},
		Math.max(0, workDeadline - Date.now()),
	);
	const hardTimer = setTimeout(
		() => {
			subAgent.abort();
			controller.abort(new Error("Subagent summary deadline reached"));
		},
		Math.max(0, hardDeadline - Date.now()),
	);

	try {
		// Refresh auth on resumes as well, including sessions whose first auth attempt timed out.
		if (modelRegistry) {
			const auth = await raceWithAbortSignal(modelRegistry.getApiKeyAndHeaders(targetModel), controller.signal);
			if (auth.ok && auth.apiKey) {
				const apiKey = auth.apiKey;
				subAgent.getApiKey = () => apiKey;
			}
		}
		controller.signal.throwIfAborted();
		if (!timedOut) {
			await raceWithAbortSignal(
				subAgent.prompt(
					`${task}\n\n[Work budget: ${workSeconds} seconds. On timeout, stop work and summarize completed work, verification, and the next small subtask.]`,
				),
				controller.signal,
			);
		} else {
			subAgent.state.messages.push({
				role: "user",
				content: `${task}\n\n[The work deadline expired during authentication. No work on this task was started.]`,
				timestamp: Date.now(),
			});
		}
		controller.signal.throwIfAborted();
		if (timedOut) {
			// prompt() has settled: the Agent is idle, unlike an in-flight steering message.
			summaryStart = subAgent.state.messages.length;
			subAgent.state.tools = [];
			subAgent.state.thinkingLevel = "off";
			subAgent.shouldStopAfterTurn = () => true;
			await raceWithAbortSignal(
				subAgent.prompt(
					"You have timed out. Stop work immediately. Do not call tools or investigate further. " +
						"Return a concise summary to the main agent now: completed work and findings, " +
						"checks actually run and their results, unfinished work or blockers, and the next small independently verifiable subtask. " +
						"Do not claim unverified work is complete. The main agent can resume this session later.",
				),
				controller.signal,
			);
		}
	} catch (error) {
		if (cancelled || signal?.aborted) {
			if (subAgent.state.pendingToolCalls.size > 0) {
				// Keep a busy tool discoverable even on the first call; resetting must not bypass it.
				saveSession(previousUsage);
				throw new Error(
					`Subagent execution aborted. Session '${sessionId}' still has an unsettled tool; do not schedule overlapping work until it stops.`,
				);
			}
			throw new Error("Subagent execution aborted");
		}
		if (!timedOut) throw error;
		summaryFailure = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(workTimer);
		clearTimeout(hardTimer);
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		subAgent.state.tools = tools;
		subAgent.state.thinkingLevel = thinkingLevel;
		subAgent.shouldStopAfterTurn = shouldStopAfterTurn;
		if (timedOut && subAgent.state.isStreaming && subAgent.state.pendingToolCalls.size === 0) {
			// A hung provider must not hold up resumption or mutate the saved transcript later.
			// An unsettled tool instead stays busy: its workspace side effects may still be running.
			const messages = structuredClone(subAgent.state.messages);
			const partial = subAgent.state.streamingMessage;
			if (partial?.role === "assistant") messages.push({ ...structuredClone(partial), stopReason: "aborted" });
			subAgent = new Agent({
				initialState: {
					systemPrompt: subAgent.state.systemPrompt,
					model: targetModel,
					thinkingLevel,
					tools,
					messages,
				},
				streamFn: subAgent.streamFunction,
				getApiKey: subAgent.getApiKey,
			});
		}
	}

	const messages = subAgent.state.messages.slice(messageStart);
	const turnUsage: SubagentUsage = { ...EMPTY_USAGE, turns };
	for (const message of messages) {
		if (message.role !== "assistant" || !message.usage) continue;
		turnUsage.input += message.usage.input || 0;
		turnUsage.output += message.usage.output || 0;
		turnUsage.cacheRead += message.usage.cacheRead || 0;
		turnUsage.cacheWrite += message.usage.cacheWrite || 0;
		turnUsage.cost += message.usage.cost?.total || 0;
	}
	const usage: SubagentUsage = {
		turns: previousUsage.turns + turnUsage.turns,
		input: previousUsage.input + turnUsage.input,
		output: previousUsage.output + turnUsage.output,
		cacheRead: previousUsage.cacheRead + turnUsage.cacheRead,
		cacheWrite: previousUsage.cacheWrite + turnUsage.cacheWrite,
		cost: previousUsage.cost + turnUsage.cost,
	};
	let output = assistantText(messages) || "(Subagent completed with no output)";
	if (timedOut) {
		const summaryMessages = summaryStart === undefined ? [] : subAgent.state.messages.slice(summaryStart);
		const summary = assistantText(
			summaryMessages.filter(
				(message) =>
					message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
			),
		);
		const notice = `Timed out after a ${workSeconds}s work budget (timeout: ${timeout}s). Resume sessionId=${sessionId} with the next small subtask.`;
		if (summary && !summaryFailure) {
			output = `${notice}\n\n${summary}`;
		} else {
			const toolLog = steps.map((step) => `- ${step.name} ${JSON.stringify(step.args)}`).join("\n");
			output =
				`${notice}\n\nSummary unavailable: ${summaryFailure ?? subAgent.state.errorMessage ?? "no summary returned"}.\n` +
				`Task: ${task}\nRecorded assistant output (may be incomplete):\n${assistantText(messages) || "(none)"}` +
				(toolLog ? `\nTool calls attempted (not proof of completion):\n${toolLog}` : "");
			if (subAgent.state.pendingToolCalls.size > 0) {
				output +=
					"\nA tool has not acknowledged cancellation and may still change the workspace. This session cannot resume until it stops; do not schedule overlapping work.";
			}
			subAgent.state.messages.push({ role: "user", content: output, timestamp: Date.now() });
		}
	}
	saveSession(usage);
	return {
		finalText: `[Subagent: ${profile.name} | Name: ${name} | Session: ${sessionId}${isResumed ? " (Resumed)" : ""}]\n${output}`,
		details: {
			...baseDetails,
			status: timedOut ? "timed_out" : "completed",
			steps,
			finalText: output,
			usage,
			turnUsage,
		},
	};
}
