import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";

export const DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 180;
export const MAX_SUBAGENT_TIMEOUT_SECONDS = 600;
export const SUBAGENT_SUMMARY_TIMEOUT_SECONDS = 30;

export interface SubagentProfile {
	name: string;
	description: string;
	systemPrompt: string;
	tools: string[];
	disabled?: boolean;
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
	status: "running" | "summarizing" | "completed" | "timed_out" | "error" | "aborted";
	timeout?: number;
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
		description: "Name of an enabled subagent role from the tool description",
	}),
	task: Type.String({
		description: "The task for the subagent to perform",
	}),
	timeout: Type.Optional(
		Type.Number({
			exclusiveMinimum: 0,
			maximum: MAX_SUBAGENT_TIMEOUT_SECONDS,
			default: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
			description:
				"Work timeout in seconds (default 180, recommended 180-300, maximum 600). At the deadline, stop work and summarize for at most 30 seconds. The entire call including summary is capped at 600 seconds, so work stops at 570 seconds if timeout exceeds 570. Resume unfinished work with sessionId in smaller subtasks.",
		}),
	),
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
