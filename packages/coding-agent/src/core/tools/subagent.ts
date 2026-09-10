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
	snippet: "Delegate small subtasks to enabled subagents with resumable sessions (default timeout 180s, maximum 600s)",
	guidelines: [
		"Split work into small, bounded, independently verifiable subtasks before delegating. Never put an entire large task into one subagent call.",
		"Use only enabled roles listed in the subagent tool description. Roles with disabled: true in their Markdown profile cannot be called or resumed.",
		"Assess each subtask's workload and set timeout in seconds: usually 180-300, default 180, maximum 600.",
		"At timeout, work is interrupted and the subagent summarizes for at most 30 seconds. The entire call including summary is capped at 600 seconds; timeout above 570 stops work at 570 seconds.",
		"A timed_out result is not completion. Resume with sessionId and assign only the next small subtask, not all remaining work at once.",
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
	const getProfiles = () => resolveSubagentProfiles(cwd, options?.agentDir, options?.customProfiles);
	const available =
		Object.entries(getProfiles())
			.map(([name, profile]) => `'${name}' (${profile.description})`)
			.join(", ") || "none";

	return {
		name: "subagent",
		label: "Subagent",
		description:
			`Delegate one small, independently verifiable subtask per call; never delegate an entire large task. Available subagents: ${available}. ` +
			"Assess workload and set timeout in seconds (usually 180-300, default 180, maximum 600). At timeout, stop work and summarize within 30 seconds. " +
			"The entire call including summary cannot exceed 600 seconds, so timeout above 570 stops work at 570 seconds. " +
			"Pass sessionId to resume unfinished work with only the next small subtask. Disabled roles cannot be called or resumed.",
		promptSnippet: subagentToolSystemPromptContribution.snippet,
		promptGuidelines: [...subagentToolSystemPromptContribution.guidelines],
		parameters: subagentSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Re-read Markdown on every call, including resumes, so disabling takes effect immediately.
			const profiles = getProfiles();
			const profile = Object.hasOwn(profiles, params.agent) ? profiles[params.agent] : undefined;
			if (!profile) {
				const available = Object.keys(profiles).join(", ") || "none";
				throw new Error(`Unknown subagent '${params.agent}'. Available subagents: ${available}`);
			}

			const result = await runSubagent({
				profile,
				task: params.task,
				timeout: params.timeout,
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
