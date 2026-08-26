import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveSubagentProfiles } from "../subagent/profiles.ts";
import { runSubagent } from "../subagent/runner.ts";
import { SubagentSessionPool } from "../subagent/session-pool.ts";
import { type SubagentProfile, type SubagentToolDetails, subagentSchema } from "../subagent/types.ts";
import type { ToolsOptions } from "./index.ts";
import { renderSubagentCall, renderSubagentResult } from "./subagent-render.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export interface SubagentToolOptions {
	agentDir?: string;
	defaultModel?: Model<any>;
	defaultThinkingLevel?: ThinkingLevel;
	toolsOptions?: ToolsOptions;
	customProfiles?: Record<string, SubagentProfile>;
	sessionPool?: SubagentSessionPool;
}

export const subagentToolSystemPromptContribution = {
	snippet: "Delegate tasks to specialized subagents with optional session persistence and friendly names",
	guidelines: [
		"Use subagent to delegate focused subtasks (e.g. agent='scout', agent='worker') with specialized tools.",
		"Each subagent is assigned a name (e.g. Jack, Alice) and sessionId. To continue a conversation with an existing subagent, pass its sessionId. Subagents retain their previous context, tool calls, and workspace knowledge across turns.",
		"For multi-step work or follow-up questions, reuse sessionId instead of repeating past background context.",
		"Omit sessionId (or start a new one) when assigning an unrelated task to avoid polluting the context window.",
		"Set resetSession=true with a sessionId if you want to reset its conversation history while keeping the session.",
	],
} as const;

export function createSubagentToolDefinition(
	cwd: string,
	options?: SubagentToolOptions,
): ToolDefinition<typeof subagentSchema, SubagentToolDetails> {
	const sessionPool = options?.sessionPool ?? new SubagentSessionPool();

	return {
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate subtasks to specialized subagents with optional session persistence. Available built-in subagents include 'scout' (fast read-only recon), 'planner' (architecture planning), 'reviewer' (code review), and 'worker' (general implementation). Pass sessionId to continue an existing subagent conversation.",
		promptSnippet: subagentToolSystemPromptContribution.snippet,
		promptGuidelines: [...subagentToolSystemPromptContribution.guidelines],
		parameters: subagentSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const profiles = {
				...resolveSubagentProfiles(cwd, options?.agentDir),
				...options?.customProfiles,
			};

			const profile = profiles[params.agent];
			if (!profile) {
				const available = Object.keys(profiles).join(", ");
				throw new Error(`Unknown subagent '${params.agent}'. Available subagents: ${available}`);
			}

			const result = await runSubagent({
				profile,
				task: params.task,
				cwd,
				sessionId: params.sessionId,
				resetSession: params.resetSession,
				sessionPool,
				parentModel: ctx?.model ?? options?.defaultModel,
				parentThinkingLevel: ctx?.thinkingLevel ?? options?.defaultThinkingLevel,
				modelRegistry: ctx?.modelRegistry,
				toolsOptions: options?.toolsOptions,
				signal,
				onUpdate,
			});

			return {
				content: [{ type: "text", text: result.finalText }],
				details: result.details,
			};
		},
		renderCall(args, theme, context) {
			return renderSubagentCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderSubagentResult(result, options, theme, context);
		},
	};
}

export function createSubagentTool(
	cwd: string,
	options?: SubagentToolOptions,
): AgentTool<typeof subagentSchema, SubagentToolDetails> {
	return wrapToolDefinition(createSubagentToolDefinition(cwd, options));
}
