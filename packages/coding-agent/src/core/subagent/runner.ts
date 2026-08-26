import { Agent, type AgentTool, type AgentToolUpdateCallback, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "../model-registry.ts";
import { allToolNames, createTool, type ToolName, type ToolsOptions } from "../tools/index.ts";
import { generateRandomName, generateSubagentSessionId } from "./names.ts";
import type { SubagentSession, SubagentSessionPool } from "./session-pool.ts";
import type { SubagentExecutionStep, SubagentProfile, SubagentToolDetails, SubagentUsage } from "./types.ts";

export interface RunSubagentOptions {
	profile: SubagentProfile;
	task: string;
	cwd: string;
	sessionId?: string;
	resetSession?: boolean;
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

export async function runSubagent(options: RunSubagentOptions): Promise<RunSubagentResult> {
	const {
		profile,
		task,
		cwd,
		sessionId: requestedSessionId,
		resetSession,
		sessionPool,
		parentModel,
		parentThinkingLevel,
		modelRegistry,
		toolsOptions,
		signal,
		onUpdate,
	} = options;

	if (signal?.aborted) {
		throw new Error("Subagent operation aborted");
	}

	// 1. Resolve Target Model
	let targetModel = parentModel;
	const targetThinkingLevel: ThinkingLevel | undefined = profile.thinkingLevel ?? parentThinkingLevel;

	if (profile.modelId && modelRegistry) {
		const slashIndex = profile.modelId.indexOf("/");
		if (slashIndex !== -1) {
			const provider = profile.modelId.slice(0, slashIndex);
			const modelId = profile.modelId.slice(slashIndex + 1);
			const found = modelRegistry.find(provider, modelId);
			if (found) {
				targetModel = found;
			}
		}
	}

	if (!targetModel) {
		throw new Error(`No model available to run subagent '${profile.name}'`);
	}

	// 2. Session Resolution & Naming
	let existingSession: SubagentSession | undefined;
	if (requestedSessionId && sessionPool) {
		if (resetSession) {
			sessionPool.delete(requestedSessionId);
		} else {
			existingSession = sessionPool.get(requestedSessionId);
		}
	}

	let sessionId: string;
	let subagentName: string;
	let subAgent: Agent;
	let isResumed = false;

	if (existingSession && existingSession.agent === profile.name) {
		isResumed = true;
		sessionId = existingSession.sessionId;
		subagentName = existingSession.name;
		subAgent = existingSession.subAgent;
		if (targetModel) {
			subAgent.state.model = targetModel;
		}
		if (targetThinkingLevel !== undefined) {
			subAgent.state.thinkingLevel = targetThinkingLevel;
		}
	} else {
		subagentName = generateRandomName();
		sessionId = requestedSessionId || generateSubagentSessionId(profile.name, subagentName);

		// Prepare Tools Subset
		const subagentTools: AgentTool<any>[] = [];
		for (const toolName of profile.tools) {
			if (allToolNames.has(toolName as ToolName)) {
				// Subagent cannot recursively call subagent itself to prevent infinite loops
				if (toolName === "subagent") continue;
				subagentTools.push(createTool(toolName as ToolName, cwd, toolsOptions));
			}
		}

		// Resolve API Key / Auth if modelRegistry is present
		let resolvedApiKey: string | undefined;
		if (modelRegistry && targetModel) {
			const auth = await modelRegistry.getApiKeyAndHeaders(targetModel);
			if (auth.ok) {
				resolvedApiKey = auth.apiKey;
			}
		}

		// Instantiate In-Process Agent
		subAgent = new Agent({
			initialState: {
				systemPrompt: profile.systemPrompt,
				model: targetModel,
				thinkingLevel: targetThinkingLevel ?? "off",
				tools: subagentTools,
			},
			streamFn: streamSimple,
			getApiKey: resolvedApiKey ? () => resolvedApiKey : undefined,
		});
	}

	// 3. Setup Abort Signal Handling
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		subAgent.abort();
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	const steps: SubagentExecutionStep[] = [];
	let turns = 0;

	// 4. Subscribe to lifecycle events for real-time streaming updates
	const unsubscribe = subAgent.subscribe((event) => {
		if (event.type === "turn_start") {
			turns += 1;
		} else if (event.type === "tool_execution_start") {
			steps.push({
				type: "toolCall",
				name: event.toolName,
				args: event.args ?? {},
			});
			if (onUpdate) {
				onUpdate({
					content: [
						{
							type: "text",
							text: `[${profile.name}: ${subagentName}] Running tool ${event.toolName}...`,
						},
					],
					details: {
						agent: profile.name,
						name: subagentName,
						sessionId,
						isResumed,
						task,
						status: "running",
						source: profile.source,
						model: targetModel ? `${targetModel.provider}/${targetModel.id}` : undefined,
						thinkingLevel: targetThinkingLevel,
						steps: [...steps],
					},
				});
			}
		}
	});

	const messageStartIndex = subAgent.state.messages.length;

	try {
		// 5. Run Agent Prompt
		await subAgent.prompt(task);

		if (aborted || signal?.aborted) {
			throw new Error("Subagent execution aborted");
		}

		// 6. Aggregate Messages & Usage for THIS turn
		const newMessages = subAgent.state.messages.slice(messageStartIndex);
		let turnInputTokens = 0;
		let turnOutputTokens = 0;
		let turnCacheReadTokens = 0;
		let turnCacheWriteTokens = 0;
		let turnCost = 0;

		let assistantText = "";
		for (const message of newMessages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				if (assistantMsg.usage) {
					turnInputTokens += assistantMsg.usage.input || 0;
					turnOutputTokens += assistantMsg.usage.output || 0;
					turnCacheReadTokens += assistantMsg.usage.cacheRead || 0;
					turnCacheWriteTokens += assistantMsg.usage.cacheWrite || 0;
					turnCost += assistantMsg.usage.cost?.total || 0;
				}

				if (Array.isArray(assistantMsg.content)) {
					for (const part of assistantMsg.content) {
						if (part.type === "text") {
							assistantText += (assistantText ? "\n" : "") + part.text;
						}
					}
				}
			}
		}

		const turnUsage: SubagentUsage = {
			turns: Math.max(turns, 1),
			input: turnInputTokens,
			output: turnOutputTokens,
			cacheRead: turnCacheReadTokens,
			cacheWrite: turnCacheWriteTokens,
			cost: turnCost,
		};

		const prevUsage = existingSession?.totalUsage ?? {
			turns: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		};

		const cumulativeUsage: SubagentUsage = {
			turns: prevUsage.turns + turnUsage.turns,
			input: prevUsage.input + turnUsage.input,
			output: prevUsage.output + turnUsage.output,
			cacheRead: prevUsage.cacheRead + turnUsage.cacheRead,
			cacheWrite: prevUsage.cacheWrite + turnUsage.cacheWrite,
			cost: prevUsage.cost + turnUsage.cost,
		};

		// 7. Update Session Pool
		if (sessionPool && sessionId) {
			const prevHistorySteps = existingSession?.historySteps ?? [];
			sessionPool.set(sessionId, {
				sessionId,
				name: subagentName,
				agent: profile.name,
				subAgent,
				createdAt: existingSession?.createdAt ?? Date.now(),
				lastUsedAt: Date.now(),
				totalTurns: cumulativeUsage.turns,
				totalUsage: cumulativeUsage,
				historySteps: [...prevHistorySteps, ...steps],
			});
		}

		const rawOutput = assistantText.trim() || "(Subagent completed with no output)";
		const headerTag = `[Subagent: ${profile.name} | Name: ${subagentName} | Session: ${sessionId}${isResumed ? " (Resumed)" : ""}]`;
		const finalOutput = `${headerTag}\n${rawOutput}`;

		const details: SubagentToolDetails = {
			agent: profile.name,
			name: subagentName,
			sessionId,
			isResumed,
			task,
			status: "completed",
			source: profile.source,
			model: targetModel ? `${targetModel.provider}/${targetModel.id}` : undefined,
			thinkingLevel: targetThinkingLevel,
			steps,
			finalText: rawOutput,
			usage: cumulativeUsage,
			turnUsage,
		};

		return {
			finalText: finalOutput,
			details,
		};
	} finally {
		if (signal) {
			signal.removeEventListener("abort", onAbort);
		}
		unsubscribe();
	}
}
