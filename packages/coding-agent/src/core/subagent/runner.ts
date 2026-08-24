import { Agent, type AgentTool, type AgentToolUpdateCallback, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "../model-registry.ts";
import { allToolNames, createTool, type ToolName, type ToolsOptions } from "../tools/index.ts";
import type { SubagentExecutionStep, SubagentProfile, SubagentToolDetails, SubagentUsage } from "./types.ts";

export interface RunSubagentOptions {
	profile: SubagentProfile;
	task: string;
	cwd: string;
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
	const { profile, task, cwd, parentModel, parentThinkingLevel, modelRegistry, toolsOptions, signal, onUpdate } =
		options;

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

	// 2. Prepare Tools Subset
	const subagentTools: AgentTool<any>[] = [];
	for (const toolName of profile.tools) {
		if (allToolNames.has(toolName as ToolName)) {
			// Subagent cannot recursively call subagent itself to prevent infinite loops
			if (toolName === "subagent") continue;
			subagentTools.push(createTool(toolName as ToolName, cwd, toolsOptions));
		}
	}

	// 3. Resolve API Key / Auth if modelRegistry is present
	let resolvedApiKey: string | undefined;
	if (modelRegistry && targetModel) {
		const auth = await modelRegistry.getApiKeyAndHeaders(targetModel);
		if (auth.ok) {
			resolvedApiKey = auth.apiKey;
		}
	}

	// 4. Instantiate In-Process Agent
	const subAgent = new Agent({
		initialState: {
			systemPrompt: profile.systemPrompt,
			model: targetModel,
			thinkingLevel: targetThinkingLevel ?? "off",
			tools: subagentTools,
		},
		streamFn: streamSimple,
		getApiKey: resolvedApiKey ? () => resolvedApiKey : undefined,
	});

	// 5. Setup Abort Signal Handling
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

	// 6. Subscribe to lifecycle events for real-time streaming updates
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
					content: [{ type: "text", text: `[${profile.name}] Running tool ${event.toolName}...` }],
					details: {
						agent: profile.name,
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

	try {
		// 7. Run Agent Prompt
		await subAgent.prompt(task);

		if (aborted || signal?.aborted) {
			throw new Error("Subagent execution aborted");
		}

		// 8. Aggregate Messages & Usage
		const messages = subAgent.state.messages;
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let cacheWriteTokens = 0;
		let totalCost = 0;

		let assistantText = "";
		for (const message of messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				if (assistantMsg.usage) {
					inputTokens += assistantMsg.usage.input || 0;
					outputTokens += assistantMsg.usage.output || 0;
					cacheReadTokens += assistantMsg.usage.cacheRead || 0;
					cacheWriteTokens += assistantMsg.usage.cacheWrite || 0;
					totalCost += assistantMsg.usage.cost?.total || 0;
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

		const usage: SubagentUsage = {
			turns: Math.max(turns, 1),
			input: inputTokens,
			output: outputTokens,
			cacheRead: cacheReadTokens,
			cacheWrite: cacheWriteTokens,
			cost: totalCost,
		};

		const finalOutput = assistantText.trim() || "(Subagent completed with no output)";

		const details: SubagentToolDetails = {
			agent: profile.name,
			task,
			status: "completed",
			source: profile.source,
			model: targetModel ? `${targetModel.provider}/${targetModel.id}` : undefined,
			thinkingLevel: targetThinkingLevel,
			steps,
			finalText: finalOutput,
			usage,
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
