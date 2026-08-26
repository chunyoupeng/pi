import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";

export interface SubagentProfile {
	name: string;
	description: string;
	systemPrompt: string;
	tools: string[];
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	source?: "built-in" | "user" | "project";
}

export interface SubagentExecutionStep {
	type: "toolCall";
	name: string;
	args: Record<string, unknown>;
}

export interface SubagentUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SubagentToolDetails {
	agent: string;
	task: string;
	status: "running" | "completed" | "error" | "aborted";
	sessionId?: string;
	name?: string;
	isResumed?: boolean;
	source?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	steps?: SubagentExecutionStep[];
	finalText?: string;
	usage?: SubagentUsage;
	turnUsage?: SubagentUsage;
	errorMessage?: string;
}

export const subagentSchema = Type.Object({
	agent: Type.String({
		description: "Name of the subagent role to run (e.g. 'scout', 'planner', 'reviewer', 'worker')",
	}),
	task: Type.String({
		description: "The task for the subagent to perform",
	}),
	sessionId: Type.Optional(
		Type.String({
			description: "Optional session ID to resume an existing subagent conversation or specify a custom session ID",
		}),
	),
	resetSession: Type.Optional(
		Type.Boolean({
			description: "If true, reset previous message history for this sessionId before running the task",
		}),
	),
});

export type SubagentToolInput = Static<typeof subagentSchema>;
